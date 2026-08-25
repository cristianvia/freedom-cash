/**
 * Ui.js
 * ------------------------------------------------------------------
 * La capa de interfaz: cajón inferior, avisos y miniaturas.
 *
 * Se queda en DOM y no en Phaser a propósito. Un listado que se desplaza,
 * con tipografía nítida a cualquier densidad de pantalla y accesible al
 * lector de pantalla, es exactamente lo que el navegador ya sabe hacer
 * bien; reimplementarlo dentro del canvas sería trabajo para salir
 * perdiendo.
 *
 * La pieza con más gracia de aquí es thumb(): las miniaturas de la tienda
 * salen recortadas del MISMO atlas que dibuja el canvas, con
 * background-position. Cero ficheros extra, cero peticiones de red
 * adicionales, y la miniatura es literalmente el edificio que vas a ver.
 * ------------------------------------------------------------------
 */

const $ = (sel, root = document) => root.querySelector(sel);

export const money = (n) => Math.round(n).toLocaleString('es-ES') + ' €';

/** Cifras compactas para el HUD, donde no cabe un millón con separadores. */
export function short(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace('.0', '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
  if (a >= 1e4) return Math.round(n / 1e3) + 'k';
  return Math.round(n).toLocaleString('es-ES');
}

export class Ui {
  constructor(atlas) {
    this.atlas = atlas;
    this.sheet = $('#sheet');
    this.scrim = $('#scrim');
    this.body = $('.sh-body', this.sheet);
    this.title = $('.sh-head h2', this.sheet);
    this.toastEl = $('#toast');
    this._toastT = null;
    this._onClose = null;

    $('.sh-x', this.sheet).addEventListener('click', () => this.close());
    this.scrim.addEventListener('click', () => this.close());
  }

  /* ============================= CAJÓN ============================= */

  open(title, html, onClose = null) {
    this.title.textContent = title;
    this.body.innerHTML = html;
    this.sheet.hidden = false;
    this.scrim.hidden = false;
    this._onClose = onClose;
    this.body.scrollTop = 0;
    return this.body;
  }

  close() {
    if (this.sheet.hidden) return;
    this.sheet.hidden = true;
    this.scrim.hidden = true;
    const cb = this._onClose;
    this._onClose = null;
    if (cb) cb();
  }

  get isOpen() { return !this.sheet.hidden; }

  /* ============================= AVISOS ============================ */

  toast(text, tone = '') {
    this.toastEl.textContent = text;
    this.toastEl.className = tone;
    this.toastEl.hidden = false;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { this.toastEl.hidden = true; }, 2600);
  }

  /* =========================== MINIATURAS ========================== */

  /**
   * Recorte del atlas como fondo CSS, escalado para caber en `box` px.
   * @returns {string} HTML de un <i class="thumb">
   */
  thumb(sprite, box = 84) {
    const s = this.atlas.sprites[sprite];
    if (!s) return '<i class="thumb"></i>';
    const [fx, fy, fw, fh] = s.frame;
    const k = Math.min(box / fw, box / fh, 1);
    const page = 'assets/atlas/' + s.page + '.' + this.atlas.format;
    // El atlas entero se escala por k y se desplaza para que quede a la
    // vista solo el recuadro que interesa.
    return `<i class="thumb" style="
      width:${Math.round(fw * k)}px; height:${Math.round(fh * k)}px;
      background-image:url('${page}');
      background-position:${-Math.round(fx * k)}px ${-Math.round(fy * k)}px;
      background-size:${Math.round(s.pageW || 2048) * k}px auto;"></i>`;
  }

  /* ============================ PLANTILLAS ========================= */

  /** Tarjeta de la tienda: imagen, cifras y un solo botón. */
  card({ sprite, title, facts, action, disabled, ghost, data }) {
    const attrs = Object.entries(data || {})
      .map(([k, v]) => `data-${k}="${String(v).replace(/"/g, '&quot;')}"`).join(' ');
    return `<div class="card">
      <div class="pic">${this.thumb(sprite, 86)}</div>
      <div class="body">
        <div class="t">${title}</div>
        <div class="facts">${facts}</div>
        <button class="go${ghost ? ' ghost' : ''}" ${attrs} ${disabled ? 'disabled' : ''}>${action}</button>
      </div>
    </div>`;
  }

  stat(k, v, tone = '') {
    return `<div class="stat"><span class="k">${k}</span><span class="v ${tone}">${v}</span></div>`;
  }
}

/** Delegación de eventos: un solo listener por contenedor, no uno por botón. */
export function onClick(root, selector, handler) {
  root.addEventListener('click', (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) handler(el, e);
  });
}
