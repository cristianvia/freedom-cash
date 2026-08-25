/**
 * CameraControl.js
 * ------------------------------------------------------------------
 * Arrastrar con un dedo, hacer zoom con dos y distinguir un toque de un
 * arrastre. Suena trivial y es justo lo que faltaba: la ciudad antigua
 * solo sabía encajarse entera en pantalla, sin acercarse a nada.
 *
 * El detalle que decide si esto se siente bien o mal es el ZOOM ANCLADO:
 * al pellizcar, el punto que hay bajo los dedos tiene que quedarse bajo
 * los dedos. Si se hace zoom sobre el centro de la pantalla en vez de
 * sobre el punto medio del pellizco, el mapa se escapa y da la sensación
 * de que la ciudad resbala.
 * ------------------------------------------------------------------
 */

const TAP_SLOP = 12;      // px que puede moverse un dedo y seguir siendo un toque
const TAP_TIME = 350;     // ms por encima de los cuales ya no es un toque

export class CameraControl {
  /**
   * @param {Phaser.Scene} scene
   * @param {{min:number, max:number}} zoom
   */
  constructor(scene, zoom = { min: 0.35, max: 1.6 }) {
    this.scene = scene;
    this.cam = scene.cameras.main;
    this.zoomRange = zoom;

    this.dragging = false;
    this.pinching = false;
    this.moved = 0;
    this.downAt = 0;
    this.downX = 0;
    this.downY = 0;
    this.lastX = 0;
    this.lastY = 0;
    this.pinchDist = 0;
    this.vx = 0;
    this.vy = 0;

    scene.input.addPointer(2);          // hasta tres punteros: dos dedos y de sobra
    scene.input.on('pointerdown', this.onDown, this);
    scene.input.on('pointermove', this.onMove, this);
    scene.input.on('pointerup', this.onUp, this);
    scene.input.on('pointerupoutside', this.onUp, this);
    scene.input.on('wheel', this.onWheel, this);
  }

  /* ------------------------------ dedos ----------------------------- */

  activePointers() {
    return this.scene.input.manager.pointers.filter(p => p.isDown && p.id > 0);
  }

  onDown(pointer) {
    const ps = this.activePointers();
    if (ps.length >= 2) {
      this.pinching = true;
      this.dragging = false;
      this.pinchDist = Phaser.Math.Distance.BetweenPoints(ps[0], ps[1]);
      return;
    }
    this.dragging = true;
    this.moved = 0;
    this.downAt = performance.now();
    this.downX = this.lastX = pointer.x;
    this.downY = this.lastY = pointer.y;
    this.vx = this.vy = 0;
  }

  onMove(pointer) {
    const ps = this.activePointers();

    if (this.pinching && ps.length >= 2) {
      const d = Phaser.Math.Distance.BetweenPoints(ps[0], ps[1]);
      if (this.pinchDist > 0) {
        const mid = {
          x: (ps[0].x + ps[1].x) / 2,
          y: (ps[0].y + ps[1].y) / 2,
        };
        this.zoomAt(mid, this.cam.zoom * (d / this.pinchDist));
      }
      this.pinchDist = d;
      return;
    }

    if (!this.dragging || !pointer.isDown) return;
    const dx = pointer.x - this.lastX;
    const dy = pointer.y - this.lastY;
    this.lastX = pointer.x;
    this.lastY = pointer.y;
    this.moved += Math.abs(dx) + Math.abs(dy);
    // El arrastre mueve la cámara al revés que el dedo: se arrastra el
    // mapa, no la ventana. Y se divide por el zoom para que a lo lejos no
    // vaya disparado.
    this.cam.scrollX -= dx / this.cam.zoom;
    this.cam.scrollY -= dy / this.cam.zoom;
    this.vx = -dx / this.cam.zoom;
    this.vy = -dy / this.cam.zoom;
  }

  onUp(pointer) {
    const ps = this.activePointers();
    if (ps.length < 2) this.pinching = false;
    if (!this.dragging) return;
    this.dragging = false;

    const quick = performance.now() - this.downAt < TAP_TIME;
    const still = this.moved < TAP_SLOP;
    if (quick && still) {
      this.vx = this.vy = 0;
      this.scene.events.emit('city-tap', pointer);
    }
  }

  onWheel(pointer, over, dx, dy) {
    this.zoomAt(pointer, this.cam.zoom * (dy > 0 ? 0.88 : 1.12));
  }

  /* ------------------------------ zoom ------------------------------ */

  /** Zoom que deja quieto el punto de pantalla `screen`. */
  zoomAt(screen, targetZoom) {
    const z = Phaser.Math.Clamp(targetZoom, this.zoomRange.min, this.zoomRange.max);
    if (z === this.cam.zoom) return;
    const before = this.cam.getWorldPoint(screen.x, screen.y);
    this.cam.setZoom(z);
    const after = this.cam.getWorldPoint(screen.x, screen.y);
    this.cam.scrollX += before.x - after.x;
    this.cam.scrollY += before.y - after.y;
  }

  /** Inercia: al soltar, la ciudad sigue un poco y frena. */
  update() {
    if (this.dragging || this.pinching) return;
    if (Math.abs(this.vx) < 0.05 && Math.abs(this.vy) < 0.05) return;
    this.cam.scrollX += this.vx;
    this.cam.scrollY += this.vy;
    this.vx *= 0.90;
    this.vy *= 0.90;
  }

  /** ¿Se está manipulando la cámara? El toque no debe contar como clic. */
  get busy() { return this.dragging || this.pinching; }

  centerOn(x, y) {
    this.cam.centerOn(x, y);
    this.vx = this.vy = 0;
  }
}
