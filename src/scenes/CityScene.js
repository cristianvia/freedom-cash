/**
 * CityScene.js
 * ------------------------------------------------------------------
 * La ciudad, dibujada y jugable.
 *
 * Tres cosas que conviene saber antes de tocar nada aquí:
 *
 * 1. EL ATLAS NO ES UN ATLAS DE PHASER. tools/pack_atlas.py escribe un
 *    sprites.json propio porque necesitamos guardar el ancla y la huella
 *    de cada modelo, que el formato de Phaser no contempla. Las páginas
 *    se cargan como imágenes sueltas y los recuadros se registran a mano
 *    con texture.add(). Sale más barato que arrastrar un formato ajeno.
 *
 * 2. LA PROFUNDIDAD ES LA SUMA col+row. En una proyección isométrica, lo
 *    que está más cerca de la cámara es lo que tiene esa suma mayor. Para
 *    un edificio de varias casillas se usa el centro de su huella, no su
 *    esquina, o un bloque de 2×2 se dibujaría detrás de su vecino.
 *
 * 3. LOS TOQUES VAN POR PÍXEL, no por rectángulo. Con rectángulos, el
 *    recuadro transparente de una torre taparía a las tres casas de
 *    delante y tocar la ciudad sería una lotería. Cuesta un poco más,
 *    pero solo se calcula cuando hay un toque, no en cada fotograma.
 * ------------------------------------------------------------------
 */

import Phaser from '../../vendor/phaser.js';
import { CameraControl } from './CameraControl.js';
import { TerrainLayer } from './TerrainLayer.js';
import { Traffic } from './Traffic.js';
import { fmtDuration } from '../game/Clock.js';
import { MATERIAL_PLANTS, CIVIC } from '../game/rules.js';

/** Cada cuánto se refrescan barras y burbujas. Sesenta veces por segundo
 *  no aporta nada: un temporizador que cuenta en segundos con refrescarse
 *  cuatro veces por segundo va sobrado, y ahorra batería. */
const OVERLAY_MS = 250;

/** Cuanto hay que mantener pulsado un edificio para levantarlo. */
const HOLD_MS = 420;

export class CityScene extends Phaser.Scene {
  constructor() {
    super('city');
  }

  init(data) {
    this.city = data.city;
    this.atlas = data.atlas;         // contenido de sprites.json
    this.onTapPlot = data.onTapPlot || (() => {});
    this.onTapEmpty = data.onTapEmpty || (() => {});
    this.onReady = data.onReady || (() => {});
    this.onHoldPlot = data.onHoldPlot || (() => {});
  }

  /* ============================= CARGA ============================= */

  preload() {
    const pages = new Set(Object.values(this.atlas.sprites).map(s => s.page));
    for (const p of pages) {
      this.load.image('page:' + p, 'assets/atlas/' + p + '.' + this.atlas.format);
    }
  }

  create() {
    this.TW = this.atlas.tile_px;
    this.TH = this.atlas.tile_h_px;
    this.views = new Map();
    this.ghost = null;
    this.placing = null;
    this._overlayAt = 0;

    this.registerFrames();
    this.makeBubbleTexture();

    // El azul de fuera del mapa: el mar sigue mas alla de la isla.
    this.cameras.main.setBackgroundColor('#1a4f6b');
    this.terrain = new TerrainLayer(this, this.city);
    this.traffic = new Traffic(this, this.city);

    this.cam = new CameraControl(this);
    this.events.on('city-tap', this.handleTap, this);

    this.scale.on('resize', () => this.terrain.redraw());
    this.syncViews();
    this.lookAtCity();
    this.onReady(this);
  }

  /**
   * Encuadra lo que hay construido, no el centro geometrico de la parcela.
   * La rejilla crece hacia fuera y casi siempre esta medio vacia: centrar
   * en su punto medio deja la ciudad arrinconada en una esquina.
   */
  lookAtCity() {
    // La decoración se siembra por toda la parcela, así que si entra en el
    // encuadre la caja abarca siempre la rejilla entera y la cámara se va
    // al zoom mínimo. Enmarcan los edificios; los arbustos ya se verán.
    let plots = this.city.list().filter(p => p.kind !== 'scenery');
    if (!plots.length) plots = this.city.list();
    if (!plots.length) return;
    let minC = 1e9, maxC = -1e9, minR = 1e9, maxR = -1e9;
    for (const p of plots) {
      minC = Math.min(minC, p.col); maxC = Math.max(maxC, p.col + p.fw - 1);
      minR = Math.min(minR, p.row); maxR = Math.max(maxR, p.row + p.fh - 1);
    }
    const c = this.isoXY((minC + maxC) / 2, (minR + maxR) / 2);

    /*
     * El zoom de entrada NO intenta que quepa la ciudad entera. Encajarlo
     * todo suena razonable y sale mal: en cuanto hay quince edificios
     * repartidos, la cámara se va al mínimo y quedan como sellos, que es
     * peor que tener que desplazarse. Se elige el zoom que hace que una
     * casilla se vea a un tamaño cómodo —unas cinco y media de ancho— y
     * el jugador navega, que para eso hay arrastre y pellizco.
     */
    const cam = this.cameras.main;
    cam.setZoom(Phaser.Math.Clamp(cam.width / (5.5 * this.TW), 0.45, 0.85));

    this.cam.centerOn(c.x, c.y - this.TH * 0.6);
  }

  /** Registra cada recuadro del atlas dentro de la textura de su página. */
  registerFrames() {
    for (const [name, s] of Object.entries(this.atlas.sprites)) {
      const tex = this.textures.get('page:' + s.page);
      if (!tex || tex.key === '__MISSING') continue;
      if (tex.has(name)) continue;
      const [x, y, w, h] = s.frame;
      tex.add(name, 0, x, y, w, h);
    }
  }

  /** Burbuja de cobro: un círculo claro con sombra, generado una vez. */
  makeBubbleTexture() {
    if (this.textures.exists('bubble')) return;
    const g = this.add.graphics();
    g.fillStyle(0x000000, 0.18); g.fillCircle(30, 32, 24);
    g.fillStyle(0xffffff, 1); g.fillCircle(30, 28, 24);
    g.fillStyle(0xf1f5f9, 1); g.fillCircle(30, 28, 20);
    g.generateTexture('bubble', 60, 60);
    g.destroy();
  }

  /* ============================ TERRENO ============================ */

  isoXY(col, row) {
    return { x: (col - row) * (this.TW / 2), y: (col + row) * (this.TH / 2) };
  }

  /** Casilla que hay bajo un punto del mundo. Es la inversa de isoXY. */
  xyToCell(x, y) {
    const a = x / (this.TW / 2);
    const b = y / (this.TH / 2);
    return { col: Math.round((a + b) / 2), row: Math.round((b - a) / 2) };
  }

  /* ============================ PARCELAS =========================== */

  /** Punto del mundo donde se posa una parcela, y su profundidad. */
  anchorOf(plot) {
    const cc = plot.col + (plot.fw - 1) / 2;
    const cr = plot.row + (plot.fh - 1) / 2;
    const p = this.isoXY(cc, cr);
    p.depth = (cc + cr) * 100;
    return p;
  }

  makeView(plot) {
    const s = this.atlas.sprites[plot.sprite];
    if (!s) return null;
    const { x, y, depth } = this.anchorOf(plot);
    const [, , w, h] = s.frame;

    const img = this.add.image(x, y, 'page:' + s.page, plot.sprite);
    img.setOrigin(s.anchor[0] / w, s.anchor[1] / h);
    img.setDepth(depth);
    img.setInteractive({ pixelPerfect: true });
    img.on('pointerdown', (pointer) => {
      this._hitUid = plot.uid;
      // Mantener pulsado levanta el edificio. El toque corto ya esta
      // cogido por cobrar, que es el gesto mil veces mas frecuente.
      clearTimeout(this._holdT);
      this._holdT = setTimeout(() => {
        if (!pointer.isDown || this.placing || this.cam.busy) return;
        if (plot.kind === 'civic' || plot.kind === 'job') return;
        this._hitUid = null;
        this.onHoldPlot(plot);
      }, HOLD_MS);
    });
    img.on('pointerup', () => clearTimeout(this._holdT));
    img.on('pointerout', () => clearTimeout(this._holdT));

    const view = { img, bubble: null, bar: null, label: null };
    this.views.set(plot.uid, view);
    return view;
  }

  /** Crea y destruye vistas para que coincidan con el estado de la ciudad. */
  syncViews() {
    for (const plot of this.city.plots.values()) {
      if (!this.views.has(plot.uid)) this.makeView(plot);
    }
    for (const [uid, v] of this.views) {
      if (!this.city.plots.has(uid)) {
        this.destroyView(v);
        this.views.delete(uid);
      }
    }
    // El suelo distingue el solar libre del ocupado, asi que cualquier
    // alta o baja obliga a repintarlo.
    const stamp = this.city.occupied.size + ':' + this.city.plots.size;
    if (stamp !== this._occStamp) {
      this._occStamp = stamp;
      this.terrain.redraw();
    }
  }

  destroyView(v) {
    v.img.destroy();
    if (v.bubble) v.bubble.destroy();
    if (v.bar) v.bar.destroy();
    if (v.label) v.label.destroy();
  }

  /** Repinta el suelo: se abrio una manzana o se urbanizo cesped. */
  refreshTerrain() {
    this.terrain.redraw();
    this.traffic.rebuild();     // se abrio una manzana: hay calle nueva
  }

  /** Fuerza a redibujar una parcela (tras mejorarla, por ejemplo). */
  refresh(uid) {
    const v = this.views.get(uid);
    if (v) { this.destroyView(v); this.views.delete(uid); }
    const plot = this.city.plots.get(uid);
    if (plot) this.makeView(plot);
  }

  /* =========================== ADORNOS ============================= */

  /**
   * Barras de obra y burbujas de cobro. Se reconstruyen enteras cada
   * cuarto de segundo en vez de mantenerse sincronizadas una a una: con
   * unas decenas de edificios sale más barato y, sobre todo, no hay forma
   * de que se queden desfasadas respecto al estado real.
   */
  updateOverlays(now) {
    for (const [uid, v] of this.views) {
      const plot = this.city.plots.get(uid);
      if (!plot) continue;
      const { x, y, depth } = this.anchorOf(plot);
      const top = y - v.img.displayHeight * v.img.originY - 10;

      if (v.bubble) { v.bubble.destroy(); v.bubble = null; }
      if (v.bar) { v.bar.destroy(); v.bar = null; }
      if (v.label) { v.label.destroy(); v.label = null; }

      if (plot.state === 'building') {
        v.img.setAlpha(0.55);
        const left = plot.doneAt - now;
        const p = this.city.buildProgress(plot, now);
        v.bar = this.add.graphics().setDepth(depth + 60);
        const W = 74, H = 9;
        v.bar.fillStyle(0x0b1220, 0.72);
        v.bar.fillRoundedRect(x - W / 2, top - H, W, H, 4);
        v.bar.fillStyle(0x38bdf8, 1);
        v.bar.fillRoundedRect(x - W / 2 + 1.5, top - H + 1.5,
          Math.max(2, (W - 3) * p), H - 3, 3);
        v.label = this.add.text(x, top - H - 13, fmtDuration(left), {
          fontFamily: 'system-ui, sans-serif', fontSize: '15px',
          color: '#e2e8f0', stroke: '#0b1220', strokeThickness: 4,
        }).setOrigin(0.5).setDepth(depth + 61);
        continue;
      }

      v.img.setAlpha(1);
      if (plot.kind === 'scenery' || plot.kind === 'civic') continue;

      /*
       * Lo que le ha pasado a este edificio tiene que VERSE encima de el.
       * Una derrama o un inquilino que se va solo se notaban en que se
       * ganaba menos, sin saber por que ni donde: la cartera parecia
       * averiada en vez de viva.
       */
      const asset = this.city.assetOf(plot);
      const vacant = asset && this.city.engine.isVacant(asset);
      if (plot.mark || vacant) {
        v.bubble = this.markerAt(x, top - 22, depth,
          vacant ? '🚪' : plot.mark.icon, vacant ? 0xfca5a5 : 0xfde68a);
        if (vacant) continue;    // vacio no produce: no hay burbuja de cobro
      }

      const got = this.city.pending(plot, now);
      if (!got.ready) continue;
      if (v.bubble) continue;    // ya hay un aviso ahi; no se apilan dos

      const full = this.city.fillOf(plot, now) >= 0.999;
      const icon = got.materials ? '🧱' : '💶';
      v.bubble = this.add.container(x, top - 24).setDepth(depth + 70);
      const back = this.add.image(0, 0, 'bubble').setScale(0.72);
      if (full) back.setTint(0xfde68a);       // lleno: deja de producir, avisa
      const txt = this.add.text(0, -2, icon, { fontSize: '19px' }).setOrigin(0.5);
      v.bubble.add([back, txt]);
      v.bubble.setSize(44, 44);
      // La burbuja late despacio: llama la atención sin agitar la pantalla.
      this.tweens.add({
        targets: v.bubble, y: top - 30, duration: 900,
        yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
    }
  }

  /** Una burbuja con un icono encima de un edificio, latiendo despacio. */
  markerAt(x, y, depth, icon, tint) {
    const c = this.add.container(x, y).setDepth(depth + 70);
    const back = this.add.image(0, 0, 'bubble').setScale(0.72);
    if (tint) back.setTint(tint);
    const txt = this.add.text(0, -2, icon, { fontSize: '19px' }).setOrigin(0.5);
    c.add([back, txt]);
    c.setSize(44, 44);
    this.tweens.add({
      targets: c, y: y - 6, duration: 900,
      yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
    return c;
  }

  /* ============================= TOQUE ============================= */

  handleTap(pointer) {
    if (this.placing) return this.tapWhilePlacing(pointer);

    const uid = this._hitUid;
    this._hitUid = null;
    if (uid != null && this.city.plots.has(uid)) {
      return this.onTapPlot(this.city.plots.get(uid), pointer);
    }
    const w = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.onTapEmpty(this.xyToCell(w.x, w.y), pointer);
  }

  /* =========================== COLOCACIÓN ========================== */

  /**
   * Modo colocar: el edificio sigue al dedo y la casilla se tiñe de verde
   * o de rojo. Es el único momento en que la rejilla se hace visible, que
   * es justo cuando importa.
   */
  beginPlacement(sprite, onConfirm, onCancel, opts = {}) {
    this.cancelPlacement();
    const s = this.atlas.sprites[sprite];
    if (!s) return false;
    const [, , w, h] = s.frame;

    const img = this.add.image(0, 0, 'page:' + s.page, sprite);
    img.setOrigin(s.anchor[0] / w, s.anchor[1] / h);
    img.setAlpha(0.75).setDepth(99000);
    const mark = this.add.graphics().setDepth(98999);

    this.placing = { sprite, img, mark, onConfirm, onCancel,
      fw: s.footprint[0], fh: s.footprint[1], cell: null,
      ignoreUid: opts.ignoreUid ?? null };
    this.input.on('pointermove', this.moveGhost, this);

    /*
     * Arranca sobre un solar VALIDO, no sobre el centro de la vista.
     * Poniendolo en el centro a secas, lo normal es que caiga en cesped o
     * en el mar: el fantasma sale en rojo y quien toque confirmar sin
     * moverlo no construye nada y no entiende por que.
     */
    const cam = this.cameras.main;
    const c = cam.getWorldPoint(cam.width / 2, cam.height / 2);
    const here = this.xyToCell(c.x, c.y);
    const start = this.city.isFree(here.col, here.row, this.placing.fw,
      this.placing.fh, opts.ignoreUid)
      ? here
      : (this.city.findSpot(this.placing.fw, this.placing.fh,
        opts.category || 'real_estate') || here);
    this.placeGhostAt(start);

    // y si ese solar queda fuera de pantalla, se lleva la camara
    const p = this.isoXY(start.col, start.row);
    if (!cam.worldView.contains(p.x, p.y)) this.cam.centerOn(p.x, p.y);
    return true;
  }

  moveGhost(pointer) {
    if (!this.placing || !pointer.isDown) return;
    const w = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.placeGhostAt(this.xyToCell(w.x, w.y));
  }

  placeGhostAt(cell) {
    const p = this.placing;
    if (!p) return;
    const col = Phaser.Math.Clamp(cell.col, 0, this.city.cols - p.fw);
    const row = Phaser.Math.Clamp(cell.row, 0, this.city.rows - p.fh);
    p.cell = { col, row };
    p.ok = this.city.isFree(col, row, p.fw, p.fh, p.ignoreUid);

    const cc = col + (p.fw - 1) / 2, cr = row + (p.fh - 1) / 2;
    const { x, y } = this.isoXY(cc, cr);
    p.img.setPosition(x, y).setTint(p.ok ? 0xffffff : 0xff8080);

    p.mark.clear();
    p.mark.fillStyle(p.ok ? 0x22c55e : 0xef4444, 0.35);
    for (let c = col; c < col + p.fw; c++) {
      for (let r = row; r < row + p.fh; r++) {
        const q = this.isoXY(c, r);
        const hw = this.TW / 2, hh = this.TH / 2;
        p.mark.beginPath();
        p.mark.moveTo(q.x, q.y - hh); p.mark.lineTo(q.x + hw, q.y);
        p.mark.lineTo(q.x, q.y + hh); p.mark.lineTo(q.x - hw, q.y);
        p.mark.closePath(); p.mark.fillPath();
      }
    }
  }

  /**
   * Colocar va en dos toques: el primero lleva el edificio a esa casilla,
   * el segundo lo confirma.
   *
   * De un solo toque, cualquier roce contra la pantalla te plantaba un
   * edificio de sesenta mil euros donde no querías; y con arrastre a secas
   * no funciona, porque en un móvil el dedo tapa justo el sitio donde
   * estás mirando. Dos toques es lo que hacen los del género, y es lo que
   * permite mover, mirar y decidir.
   */
  tapWhilePlacing(pointer) {
    const p = this.placing;
    const w = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const cell = this.xyToCell(w.x, w.y);
    const same = p.cell && p.cell.col === Phaser.Math.Clamp(cell.col, 0, this.city.cols - p.fw)
      && p.cell.row === Phaser.Math.Clamp(cell.row, 0, this.city.rows - p.fh);
    if (same && p.ok) return this.confirmPlacement();
    this.placeGhostAt(cell);
  }

  confirmPlacement() {
    const p = this.placing;
    if (!p || !p.ok || !p.cell) return;
    const { col, row } = p.cell;
    const cb = p.onConfirm;
    this.cancelPlacement();
    cb(col, row);
  }

  cancelPlacement(fireCancel = false) {
    const p = this.placing;
    if (!p) return;
    this.input.off('pointermove', this.moveGhost, this);
    p.img.destroy();
    p.mark.destroy();
    this.placing = null;
    if (fireCancel && p.onCancel) p.onCancel();
  }

  /* ============================ EFECTOS ============================ */

  /** Monedas que suben al recoger: el premio tiene que verse. */
  popCollect(plot, text, tone = 'cash') {
    const { x, y, depth } = this.anchorOf(plot);
    const v = this.views.get(plot.uid);
    const top = y - (v ? v.img.displayHeight * v.img.originY : 60) - 20;
    const t = this.add.text(x, top, text, {
      fontFamily: 'system-ui, sans-serif', fontSize: '20px', fontStyle: 'bold',
      color: tone === 'mat' ? '#fbbf24' : '#4ade80',
      stroke: '#0b1220', strokeThickness: 5,
    }).setOrigin(0.5).setDepth(depth + 200);
    this.tweens.add({
      targets: t, y: top - 52, alpha: 0, duration: 1000,
      ease: 'Cubic.easeOut', onComplete: () => t.destroy(),
    });
  }

  /** Sacudida corta al terminar una obra. */
  popBuilt(plot) {
    const v = this.views.get(plot.uid);
    if (!v) return;
    v.img.setScale(0.86);
    this.tweens.add({ targets: v.img, scale: 1, duration: 420, ease: 'Back.easeOut' });
  }

  centerOnPlot(plot) {
    const { x, y } = this.anchorOf(plot);
    this.cam.centerOn(x, y);
  }

  /* ============================= BUCLE ============================= */

  update(time, delta) {
    this.cam.update();
    this.terrain.update(time);
    this.traffic.update(delta);
    if (time - this._overlayAt > OVERLAY_MS) {
      this._overlayAt = time;
      this.syncViews();
      this.updateOverlays(Date.now());
    }
  }
}
