/**
 * Bus.js
 * ------------------------------------------------------------------
 * Un emisor de eventos de doce líneas.
 *
 * Existe por una razón concreta: sin él, un tutorial solo puede decir
 * «pulsa siguiente». Para que un paso no avance hasta que el jugador HAGA
 * la cosa, alguien tiene que avisar de que la cosa ha pasado, y ese aviso
 * tiene que salir del juego, no de la interfaz.
 *
 * Los eventos que se emiten, todos desde boot.js:
 *
 *   shop:open      se abrió la tienda
 *   build:placed   se confirmó una construcción   { plot }
 *   build:done     terminó una obra               { plot }
 *   collect        se cobró algo                  { plot, cash, materials }
 *   level:up       subió el nivel de ciudad       { level }
 *   advisor:open   se entró en un edificio de servicio  { id }
 *   ie:open        se desplegó el indicador
 *   period         pasó un mes del motor          { snap }
 * ------------------------------------------------------------------
 */

export class Bus {
  constructor() { this.map = new Map(); }

  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name).add(fn);
    return () => this.off(name, fn);
  }

  off(name, fn) {
    const set = this.map.get(name);
    if (set) set.delete(fn);
  }

  emit(name, data) {
    const set = this.map.get(name);
    if (!set) return;
    // se copia antes de recorrer: un oyente puede darse de baja a si mismo
    // al recibir el evento, y modificar el Set mientras se itera lo rompe
    for (const fn of [...set]) {
      try { fn(data); } catch (e) { console.error('[bus] ' + name, e); }
    }
  }
}

export const bus = new Bus();
