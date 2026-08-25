/**
 * Clock.js
 * ------------------------------------------------------------------
 * El latido del juego, ahora que no hay turnos.
 *
 * Antes el jugador pulsaba «Cobrar y pasar de mes» y endTurn() hacía
 * nueve cosas a la vez. Ahora nadie pulsa nada: el mes pasa solo cada dos
 * horas reales, y lo hace en segundo plano.
 *
 * Lo importante de este fichero es el PROGRESO OFFLINE. En un builder, la
 * mitad de la partida ocurre con el juego cerrado: se guarda cuándo se
 * vio el juego por última vez y al volver se recuperan los meses que
 * faltan. Sin esto, cerrar la pestaña sería una penalización y el género
 * no funcionaría.
 *
 * El tope de MAX_CATCHUP_PERIODS no está por rendimiento sino por
 * honestidad: si alguien vuelve tras un mes, no debe encontrarse la
 * partida arrasada por trescientos sesenta eventos negativos que no pudo
 * ver ni responder.
 * ------------------------------------------------------------------
 */

import { PERIOD_MS, MAX_CATCHUP_PERIODS } from './rules.js';

export class Clock {
  /**
   * @param {function} onPeriod  se llama por cada mes que pasa
   */
  constructor(onPeriod) {
    this.onPeriod = onPeriod;
    this.lastPeriodAt = Date.now();
    this.startedAt = Date.now();
  }

  now() { return Date.now(); }

  /** Cuánto falta para el siguiente mes, en ms. */
  msToNextPeriod() {
    return Math.max(0, this.lastPeriodAt + PERIOD_MS - this.now());
  }

  /** Fracción recorrida del mes actual, de 0 a 1. */
  periodProgress() {
    return Math.min(1, (this.now() - this.lastPeriodAt) / PERIOD_MS);
  }

  /**
   * Ejecuta los meses vencidos. Se llama en cada frame (es baratísimo si
   * no hay ninguno) y también al cargar la partida, donde puede haber
   * muchos de golpe.
   *
   * @returns {object[]} los snapshots de los meses ejecutados
   */
  catchUp() {
    const out = [];
    let due = Math.floor((this.now() - this.lastPeriodAt) / PERIOD_MS);
    if (due <= 0) return out;

    if (due > MAX_CATCHUP_PERIODS) {
      // Se descartan los meses más viejos en vez de los más nuevos: al
      // jugador le importa el estado en que se encuentra el mercado HOY,
      // no la crónica de lo que se perdió.
      this.lastPeriodAt += (due - MAX_CATCHUP_PERIODS) * PERIOD_MS;
      due = MAX_CATCHUP_PERIODS;
    }

    for (let i = 0; i < due; i++) {
      this.lastPeriodAt += PERIOD_MS;
      const snap = this.onPeriod(i, due);
      if (snap) out.push(snap);
    }
    return out;
  }

  toJSON() {
    return { lastPeriodAt: this.lastPeriodAt, startedAt: this.startedAt };
  }

  load(data) {
    if (!data) return;
    this.lastPeriodAt = data.lastPeriodAt ?? Date.now();
    this.startedAt = data.startedAt ?? Date.now();
    // Un reloj del futuro solo puede venir de que el jugador haya movido
    // la hora del sistema hacia atrás. Se corrige en vez de dejar el juego
    // congelado esperando una fecha que ya pasó.
    const now = Date.now();
    if (this.lastPeriodAt > now) this.lastPeriodAt = now;
  }
}

/** Formatea una espera en el estilo corto de los builders: 2h 14m, 45s. */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}
