/**
 * Guide.js
 * ------------------------------------------------------------------
 * El recorrido guiado del principio. Sustituye a tutorial.js.
 *
 * La diferencia de fondo con el módulo viejo no es estética: aquel
 * iluminaba selectores del DOM y avanzaba con un botón de «siguiente».
 * Aquí un paso NO avanza hasta que el jugador hace la acción de verdad.
 * Se aprende construyendo y cobrando, no leyendo que se puede construir y
 * cobrar.
 *
 * Eso obliga a dos cosas que este fichero resuelve:
 *
 *   1. ESCUCHAR AL JUEGO. Cada paso espera un evento del Bus con una
 *      condición. Sin eso no hay forma de saber si el jugador hizo lo que
 *      se le pedía o pulsó otra cosa.
 *
 *   2. ILUMINAR SOBRE EL LIENZO. La mitad de las acciones no ocurren en
 *      el DOM sino sobre el canvas —tocar un edificio, elegir un solar—,
 *      así que el foco acepta también una parcela de la ciudad y calcula
 *      dónde cae en pantalla usando la cámara.
 *
 * Y una regla de diseño: el recorrido termina ANTES de tocar impuestos o
 * seguros. Esos conceptos no significan nada cuando todavía no tienes
 * renta que declarar; van en la Escuela, que se abre sola cuando te tocan
 * de cerca.
 * ------------------------------------------------------------------
 */

const KEY = 'freedomcash.guide.v1';

export class Guide {
  /**
   * @param {object} ctx  { bus, city, scene, ui }
   * @param {function} onDone
   */
  constructor(ctx, onDone) {
    this.ctx = ctx;
    this.onDone = onDone || (() => {});
    this.i = 0;
    this.unsub = null;
    this.steps = buildSteps(ctx);
    this._build();
    this.show();
  }

  static get done() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }

  static markDone() {
    try { localStorage.setItem(KEY, '1'); } catch (e) { /* modo privado */ }
  }

  static reset() {
    try { localStorage.removeItem(KEY); } catch (e) { /* nada */ }
  }

  /* --------------------------- MONTAJE --------------------------- */

  _build() {
    this.root = document.createElement('div');
    this.root.id = 'guide';
    this.root.innerHTML = `
      <div class="gd-spot"></div>
      <div class="gd-card">
        <div class="gd-step"></div>
        <h3></h3>
        <p></p>
        <div class="gd-foot">
          <button class="gd-skip">Saltar</button>
          <button class="gd-next">Vale</button>
        </div>
      </div>`;
    document.body.appendChild(this.root);

    this.spot = this.root.querySelector('.gd-spot');
    this.card = this.root.querySelector('.gd-card');
    this.root.querySelector('.gd-skip').onclick = () => this.finish();
    this.root.querySelector('.gd-next').onclick = () => this.advance();

    this._onResize = () => this.place();
    window.addEventListener('resize', this._onResize);
    // el foco sigue a la cámara: si el jugador desplaza el mapa, el
    // agujero tiene que seguir sobre el edificio, no quedarse quieto
    this._raf = setInterval(() => this.place(), 120);
  }

  /* ---------------------------- PASOS ---------------------------- */

  show() {
    if (this.unsub) { this.unsub(); this.unsub = null; }
    const step = this.steps[this.i];
    if (!step) return this.finish();

    this.root.querySelector('.gd-step').textContent =
      `Paso ${this.i + 1} de ${this.steps.length}`;
    this.root.querySelector('h3').textContent = step.title;
    this.root.querySelector('p').textContent = step.text;

    // Un paso con condición no lleva botón: avanza cuando se cumple. Si
    // llevara «siguiente», el jugador lo pulsaría sin hacer nada y el
    // tutorial volvería a ser un folleto.
    const gated = !!step.on;
    this.root.querySelector('.gd-next').hidden = gated;
    this.root.classList.toggle('gated', gated);

    if (gated) {
      this.unsub = this.ctx.bus.on(step.on, (data) => {
        if (step.when && !step.when(data)) return;
        this.advance();
      });
    }
    this.place();
  }

  advance() {
    this.i++;
    this.show();
  }

  /* ---------------------------- FOCO ----------------------------- */

  /** Rectángulo en pantalla del objetivo del paso, o null. */
  targetRect() {
    const step = this.steps[this.i];
    if (!step || !step.target) return null;
    const t = step.target();
    if (!t) return null;

    if (t.nodeType === 1) {
      const r = t.getBoundingClientRect();
      return r.width ? r : null;
    }
    // una parcela de la ciudad: de coordenadas de mundo a pantalla
    const scene = this.ctx.scene;
    if (!scene || !scene.cameras) return null;
    const cam = scene.cameras.main;
    const { x, y } = scene.anchorOf(t);
    const sx = (x - cam.scrollX) * cam.zoom;
    const sy = (y - cam.scrollY) * cam.zoom;
    const w = 130 * cam.zoom, h = 150 * cam.zoom;
    return { left: sx - w / 2, top: sy - h * 0.82, width: w, height: h };
  }

  place() {
    const r = this.targetRect();
    if (!r) {
      this.spot.style.opacity = '0';
    } else {
      const pad = 10;
      this.spot.style.opacity = '1';
      this.spot.style.left = (r.left - pad) + 'px';
      this.spot.style.top = (r.top - pad) + 'px';
      this.spot.style.width = (r.width + pad * 2) + 'px';
      this.spot.style.height = (r.height + pad * 2) + 'px';
    }

    // la tarjeta se aparta del foco: arriba si el foco está abajo
    const below = r && r.top < window.innerHeight * 0.5;
    this.card.classList.toggle('bottom', !!below);
  }

  /* ----------------------------- FIN ----------------------------- */

  finish() {
    if (this.unsub) this.unsub();
    clearInterval(this._raf);
    window.removeEventListener('resize', this._onResize);
    this.root.remove();
    Guide.markDone();
    this.onDone();
  }
}

/* ==================================================================
   El recorrido. Un paso por gesto, y cada uno espera al gesto real.
   ================================================================== */

function buildSteps(ctx) {
  const { city } = ctx;
  const find = (fn) => () => city.list().find(fn) || null;

  return [
    {
      title: 'Esta es tu ciudad',
      text: 'Cada edificio que levantes te pagará una renta. Cuando esas rentas '
        + 'cubran lo que te cuesta vivir, dejarás de depender del sueldo. Eso es '
        + 'todo el juego.',
    },
    {
      title: 'Empieza por tu sueldo',
      text: 'Ese es tu trabajo. Acumula dinero solo y se para cuando se llena, '
        + 'así que hay que pasar a cobrarlo. Tócalo.',
      target: find(p => p.kind === 'job'),
      on: 'collect',
      when: (d) => d.plot && d.plot.kind === 'job',
    },
    {
      title: 'Eso es cambiar tiempo por dinero',
      text: 'Tu sueldo solo entra si vuelves a por él. Un activo, en cambio, '
        + 'paga aunque no estés. Vamos a construir el primero: pulsa Construir.',
      target: () => document.querySelector('#dk-shop'),
      on: 'shop:open',
    },
    {
      title: 'Primero, materiales',
      text: 'Sin ladrillos no se levanta nada. Construye la Ladrillera: elige un '
        + 'solar libre —los del contorno a rayas— y toca dos veces para confirmar.',
      on: 'build:placed',
    },
    {
      title: 'Las obras tardan',
      text: 'Como en la vida. Mientras tanto, mira la barra de arriba: es tu '
        + 'Indicador de Emancipación, cuánto cubren tus rentas de tus gastos. '
        + 'Tócala.',
      target: () => document.querySelector('#ie'),
      on: 'ie:open',
    },
    {
      title: 'Cobra lo que has producido',
      text: 'Cuando un edificio tiene algo dentro, le sale una burbuja encima. '
        + 'Tócala para recogerlo.',
      on: 'collect',
      when: (d) => d.plot && d.plot.kind !== 'job',
    },
    {
      title: 'Ahora sí: tu primer activo',
      text: 'Vuelve a Construir y levanta algo de la lista de abajo. Fíjate en que '
        + 'puedes pagarlo al contado o con hipoteca: con hipoteca entras con menos '
        + 'dinero, pero cargas con una cuota. Esa decisión es el juego entero.',
      target: () => document.querySelector('#dk-shop'),
      on: 'build:placed',
    },
    {
      title: 'Ya tienes algo que trabaja por ti',
      text: 'A partir de aquí es repetir: cobrar, reinvertir y vigilar que las '
        + 'rentas suban más rápido que los gastos. En Más › La Escuela tienes las '
        + 'explicaciones, y se irán abriendo solas según te vayan haciendo falta.',
    },
  ];
}
