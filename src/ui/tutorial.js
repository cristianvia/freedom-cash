/**
 * tutorial.js — Walk-through guiado (coach-marks) para nuevos jugadores.
 * Sin dependencias del motor: recibe una lista de pasos { sel, title, text }
 * e ilumina cada elemento con un spotlight + tooltip. Modal (bloquea clics).
 */
export class Tutorial {
  /**
   * @param {{sel?:string,title:string,text:string}[]} steps
   * @param {() => void} onDone  callback al terminar/saltar
   */
  constructor(steps, onDone) {
    this.steps = steps;
    this.onDone = onDone || (() => {});
    this.i = 0;
    this._build();
  }

  _build() {
    this.block = document.createElement('div'); this.block.className = 'tut-block';
    this.mask = document.createElement('div'); this.mask.className = 'tut-mask';
    this.pop = document.createElement('div'); this.pop.className = 'tut-pop';
    document.body.append(this.block, this.mask, this.pop);
    this._onResize = () => this.render();
    window.addEventListener('resize', this._onResize);
    this.render();
  }

  render() {
    const step = this.steps[this.i];
    const el = step.sel ? document.querySelector(step.sel) : null;
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    // recalcula posición tras el posible scroll
    requestAnimationFrame(() => this._place(step, el));
  }

  _place(step, el) {
    const last = this.i === this.steps.length - 1;
    this.pop.innerHTML = `
      <div class="tut-step">Paso ${this.i + 1} de ${this.steps.length}</div>
      <h3>${step.title}</h3>
      <p>${step.text}</p>
      <div class="tut-actions">
        <button class="btn-sm tut-skip">Saltar</button>
        <button class="btn-sm tut-next">${last ? '¡A jugar!' : 'Siguiente ▸'}</button>
      </div>`;
    this.pop.querySelector('.tut-next').onclick = () => this.next();
    this.pop.querySelector('.tut-skip').onclick = () => this.finish();

    if (el) {
      const r = el.getBoundingClientRect();
      const pad = 6;
      this.mask.style.display = 'block';
      this.mask.style.left = (r.left - pad) + 'px';
      this.mask.style.top = (r.top - pad) + 'px';
      this.mask.style.width = (r.width + pad * 2) + 'px';
      this.mask.style.height = (r.height + pad * 2) + 'px';

      // coloca el tooltip: derecha > izquierda > abajo > arriba, según haya hueco
      const pw = this.pop.offsetWidth || 320;
      const ph = this.pop.offsetHeight || 170;
      const gap = 14;
      const clampY = y => Math.min(Math.max(10, y), window.innerHeight - ph - 10);
      const clampX = x => Math.min(Math.max(10, x), window.innerWidth - pw - 10);
      let left, top;
      if (r.right + gap + pw < window.innerWidth) { left = r.right + gap; top = clampY(r.top); }
      else if (r.left - gap - pw > 0) { left = r.left - gap - pw; top = clampY(r.top); }
      else if (r.bottom + gap + ph < window.innerHeight) { left = clampX(r.left); top = r.bottom + gap; }
      else { left = clampX(r.left); top = clampY(r.top - ph - gap); }
      this.pop.style.left = left + 'px';
      this.pop.style.top = top + 'px';
      this.pop.style.transform = 'none';
    } else {
      // paso de bienvenida: centrado, sin spotlight
      this.mask.style.display = 'none';
      this.pop.style.left = '50%';
      this.pop.style.top = '50%';
      this.pop.style.transform = 'translate(-50%, -50%)';
    }
  }

  next() {
    if (this.i < this.steps.length - 1) { this.i++; this.render(); }
    else this.finish();
  }

  finish() {
    window.removeEventListener('resize', this._onResize);
    this.block.remove(); this.mask.remove(); this.pop.remove();
    this.onDone();
  }
}
