/**
 * Incidents.js
 * ------------------------------------------------------------------
 * Lo que le pasa a tu ciudad, y las decisiones que te obliga a tomar.
 *
 * EL PROBLEMA QUE ARREGLA
 *
 * `endTurn()` sorteaba un evento cada mes y lo resolvía él solo. Con el
 * mes convertido en dos horas de reloj, eso significaba que cada dos
 * horas ocurría algo —una derrama, un inquilino que se va, un dilema con
 * dos opciones— y el jugador no se enteraba de nada. Los treinta y siete
 * eventos del juego, que son la mitad de su contenido educativo, se
 * estaban tirando a la basura.
 *
 * Ahora el reparto es:
 *
 *   DILEMAS -> esperan al jugador. Son decisiones con dos caminos y
 *   consecuencias distintas, o sea justo lo que el juego quiere enseñar.
 *   Resolverlos por él sería quitarle la parte que importa. Se quedan
 *   marcados sobre el edificio afectado hasta que los atiende.
 *
 *   TODO LO DEMÁS -> se aplica solo, porque no hay nada que decidir, pero
 *   deja rastro: una marca sobre el edificio al que le ha pasado y una
 *   línea en el parte de noticias. Que te suba la cuota o se te vacíe un
 *   piso tiene que VERSE; si no, el jugador solo nota que gana menos y no
 *   sabe por qué.
 * ------------------------------------------------------------------
 */

import { INCIDENT_MS, MAX_CATCHUP_INCIDENTS } from './rules.js';

/** Un evento vacío: deja que el mes avance sin que ocurra nada. */
export const NO_EVENT = { id: '__none', type: 'neutral', title: '', description: '' };

/** Cuántas líneas de parte se guardan. */
const FEED_MAX = 30;

/** Cuánto dura la marca de un suceso ya aplicado, en ms. */
const MARK_MS = 6 * 60 * 1000;

export class Incidents {
  constructor(engine, city, bus) {
    this.engine = engine;
    this.city = city;
    this.bus = bus;
    this.pending = [];   // dilemas esperando decisión
    this.feed = [];      // parte de noticias, lo más nuevo primero
    this.lastAt = Date.now();
    this._seq = 0;
  }

  /**
   * Reloj propio, suelto del mes del motor.
   *
   * Atado al mes, ocurría un suceso cada dos horas de reloj y la ciudad
   * parecía muerta. Acortar el mes para que pasaran más cosas habría
   * disparado la inflación, que es justo lo que el mes de dos horas evita.
   * Son dos relojes porque miden dos cosas distintas: la macroeconomía es
   * lenta, y lo que te pasa a ti no tiene por qué serlo.
   *
   * @returns {number} cuántos sucesos se han recuperado
   */
  catchUp(now = Date.now()) {
    let due = Math.floor((now - this.lastAt) / INCIDENT_MS);
    if (due <= 0) return 0;

    if (due > MAX_CATCHUP_INCIDENTS) {
      // se tiran los viejos, no los nuevos: al jugador le importa el
      // estado en que se encuentra la ciudad hoy, no la crónica entera
      this.lastAt += (due - MAX_CATCHUP_INCIDENTS) * INCIDENT_MS;
      due = MAX_CATCHUP_INCIDENTS;
    }
    for (let i = 0; i < due; i++) {
      this.lastAt += INCIDENT_MS;
      this.roll(due > 1);
    }
    return due;
  }

  /* ============================ SORTEO ============================= */

  /**
   * Se llama una vez por mes del motor. Devuelve true si ha quedado algo
   * pendiente de decidir.
   */
  roll(quiet = false) {
    const ev = this.engine.pickEvent();
    if (!ev) return false;

    if (this.engine.isDilemma(ev)) {
      // Un dilema no se resuelve solo. Y si se acumulan varios porque el
      // jugador estuvo días fuera, solo se guarda uno: volver y encontrar
      // ocho decisiones en cola es un castigo, no un juego.
      if (this.pending.length >= 1) return true;
      this.pending.push({
        uid: ++this._seq,
        ev,
        plotUid: this.pickPlotFor(ev),
        at: Date.now(),
      });
      this.bus.emit('incident:new', { dilemma: true, ev });
      return true;
    }

    this.applyNow(ev, quiet);
    return false;
  }

  /** Aplica un suceso sin decisión y deja rastro. */
  applyNow(ev, quiet = false) {
    const adj = this.engine.applyEvent(ev);
    this.engine.cash += Math.round(adj.cashDelta || 0);

    const plotUid = this.pickPlotFor(ev, adj);
    if (plotUid) {
      const plot = this.city.plots.get(plotUid);
      if (plot) plot.mark = { icon: iconFor(ev), until: Date.now() + MARK_MS };
    }

    this.log({
      title: ev.title,
      text: adj._shock || ev.description || '',
      tone: ev.tone || 'neutral',
      cash: Math.round(adj.cashDelta || 0),
      covered: adj._covered || 0,
      plotUid,
    });
    if (!quiet) this.bus.emit('incident:new', { dilemma: false, ev, adj });
    return adj;
  }

  /**
   * A qué edificio le ha tocado. El motor devuelve el TÍTULO del activo
   * afectado en `adj._asset`, así que se busca la parcela cuyo activo se
   * llame así; si el suceso es de sector, vale cualquiera de esa
   * categoría. Sin esto la marca no tendría dónde ponerse.
   */
  pickPlotFor(ev, adj = null) {
    const byTitle = adj && (adj._asset || adj._vacancyAsset);
    const mine = this.city.list().filter(p => p.kind === 'asset' && p.instanceId);

    if (byTitle) {
      const hit = mine.find(p => {
        const a = this.city.assetOf(p);
        return a && a.title === byTitle;
      });
      if (hit) return hit.uid;
    }
    if (ev.sector) {
      const pool = mine.filter(p => {
        const a = this.city.assetOf(p);
        return a && a.category === ev.sector;
      });
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)].uid;
    }
    if (ev.requires === 'any_asset' && mine.length) {
      return mine[Math.floor(Math.random() * mine.length)].uid;
    }
    return null;
  }

  /* =========================== DECISIÓN ============================ */

  /** Resuelve un dilema con la opción elegida. */
  resolve(uid, choiceIndex) {
    const i = this.pending.findIndex(p => p.uid === uid);
    if (i < 0) return null;
    const item = this.pending.splice(i, 1)[0];
    const adj = this.engine.applyEvent(item.ev, choiceIndex);
    this.engine.cash += Math.round(adj.cashDelta || 0);

    const choice = item.ev.choices[choiceIndex] || {};
    this.log({
      title: item.ev.title,
      text: 'Elegiste: ' + (choice.label || '—'),
      tone: (adj.cashDelta || 0) >= 0 ? 'good' : 'bad',
      cash: Math.round(adj.cashDelta || 0),
      plotUid: item.plotUid,
    });
    this.bus.emit('incident:resolved', { ev: item.ev, choice, adj });
    return adj;
  }

  get waiting() { return this.pending.length; }

  /** El dilema que está esperando, si hay alguno. */
  next() { return this.pending[0] || null; }

  /* =========================== NOTICIAS ============================ */

  log(entry) {
    this.feed.unshift({ ...entry, at: Date.now() });
    if (this.feed.length > FEED_MAX) this.feed.length = FEED_MAX;
  }

  /** Limpia las marcas caducadas de los edificios. */
  tickMarks(now = Date.now()) {
    let changed = false;
    for (const p of this.city.plots.values()) {
      if (p.mark && p.mark.until < now) { delete p.mark; changed = true; }
    }
    return changed;
  }

  toJSON() {
    return { pending: this.pending, feed: this.feed.slice(0, 12),
      seq: this._seq, lastAt: this.lastAt };
  }

  load(d) {
    if (!d) return;
    this.pending = d.pending || [];
    this.feed = d.feed || [];
    this._seq = d.seq || 0;
    this.lastAt = d.lastAt ?? Date.now();
    // un reloj del futuro solo sale de mover la hora del sistema
    if (this.lastAt > Date.now()) this.lastAt = Date.now();
  }
}

/** Icono de la marca según lo que ha pasado. */
function iconFor(ev) {
  if (ev.type === 'asset_shock') {
    if (ev.shock === 'vacancy') return '🚪';
    if (ev.shock === 'capex') return '🔧';
    if (ev.shock === 'windfall') return '💰';
    if (ev.shock === 'rent_review') return '📈';
  }
  if (ev.type === 'vacancy_real_estate') return '🚪';
  if (ev.type === 'sector_zero') return '📉';
  if (ev.type === 'sector_bonus') return '📈';
  if (ev.type === 'mortgage_cost_pct') return '🏦';
  return ev.tone === 'good' ? '✨' : '⚠️';
}
