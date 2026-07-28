/**
 * Achievements.js — Logros y meta-progresión.
 * ------------------------------------------------------------------
 * Es lo único que sobrevive a una partida: los logros y sus contadores
 * se guardan en localStorage, así que cada partida deja poso aunque la
 * pierdas. Sin dependencias de UI (testeable en Node).
 *
 * Las reglas viven en achievements.json y se evalúan contra tres espacios:
 *   stat → métricas de la partida en curso (EconomyEngine.status())
 *   run  → contadores/banderas de ESTA partida (se reinician al empezar)
 *   life → contadores/banderas acumulados entre partidas (persisten)
 */

const KEY = 'freedomcash.achievements.v1';

export class Achievements {
  constructor(data) {
    this.defs = data.achievements || [];
    this.tiers = data.tiers || {};
    this.categories = data.categories || {};
    this.life = { counters: {}, sets: {}, unlocked: {} };
    this.run = {};
    this.load();
  }

  /* ------------------------- PERSISTENCIA -------------------------- */

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        this.life = {
          counters: d.counters || {},
          sets: d.sets || {},
          unlocked: d.unlocked || {},
        };
      }
    } catch (e) { /* almacenamiento no disponible: se juega sin meta-progreso */ }
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.life)); }
    catch (e) { /* noop */ }
  }

  /** Borra todo el progreso de logros (para pruebas). */
  reset() { this.life = { counters: {}, sets: {}, unlocked: {} }; this.run = {}; this.save(); }

  /* --------------------------- CONTADORES --------------------------- */

  /** Empieza una partida nueva: los contadores de 'run' se van a cero. */
  newRun() { this.run = {}; }

  bumpRun(key, n = 1) { this.run[key] = (this.run[key] || 0) + n; }
  setRun(key, value) { this.run[key] = value; }

  bumpLife(key, n = 1) {
    this.life.counters[key] = (this.life.counters[key] || 0) + n;
    this.save();
  }

  /** Guarda el mínimo histórico (p. ej. la victoria más rápida). */
  minLife(key, value) {
    const cur = this.life.counters[key];
    if (cur == null || value < cur) { this.life.counters[key] = value; this.save(); }
  }

  /** Añade a un conjunto acumulado (p. ej. perfiles con los que has ganado). */
  addLifeSet(key, value) {
    const set = this.life.sets[key] || (this.life.sets[key] = []);
    if (!set.includes(value)) { set.push(value); this.save(); }
  }

  /* --------------------------- EVALUACIÓN --------------------------- */

  /** Resuelve el valor de una regla en su espacio (stat / run / life). */
  _value(rule, stat, derived) {
    if ('stat' in rule) return stat ? stat[rule.stat] : undefined;
    if ('run' in rule) {
      const k = rule.run;
      return (derived && k in derived) ? derived[k] : this.run[k];
    }
    if ('life' in rule) {
      const k = rule.life;
      if (this.life.sets[k]) return this.life.sets[k].length;
      return this.life.counters[k];
    }
    return undefined;
  }

  /** ¿Se cumple una regla? Varias condiciones en la misma regla son AND. */
  _test(rule, stat, derived) {
    const v = this._value(rule, stat, derived);
    if ('is' in rule) return Boolean(v) === Boolean(rule.is);
    const n = Number(v ?? 0);
    if ('gte' in rule && !(n >= rule.gte)) return false;
    if ('lte' in rule && !(n <= rule.lte)) return false;
    if ('eq' in rule && n !== rule.eq) return false;
    return 'gte' in rule || 'lte' in rule || 'eq' in rule;
  }

  isUnlocked(id) { return !!this.life.unlocked[id]; }

  /**
   * Evalúa todos los logros pendientes y desbloquea los que se cumplan.
   * @param {object} stat     EconomyEngine.status()
   * @param {object} derived  valores calculados de la cartera (ver main.js)
   * @returns {object[]} definiciones de los logros recién desbloqueados
   */
  evaluate(stat, derived = {}) {
    const fresh = [];
    for (const def of this.defs) {
      if (this.isUnlocked(def.id)) continue;
      const rules = def.rules || [];
      if (!rules.length) continue;
      if (rules.every(r => this._test(r, stat, derived))) {
        this.life.unlocked[def.id] = Date.now();
        fresh.push(def);
      }
    }
    if (fresh.length) this.save();
    return fresh;
  }

  /* ---------------------------- CONSULTA ---------------------------- */

  pointsOf(def) { return (this.tiers[def.tier] || {}).points || 0; }

  /** Resumen para la galería y la liga. */
  progress() {
    const unlocked = this.defs.filter(d => this.isUnlocked(d.id));
    return {
      unlocked: unlocked.length,
      total: this.defs.length,
      points: unlocked.reduce((s, d) => s + this.pointsOf(d), 0),
      maxPoints: this.defs.reduce((s, d) => s + this.pointsOf(d), 0),
    };
  }

  /** Logros agrupados por categoría, en el orden del JSON. */
  byCategory() {
    const groups = new Map();
    for (const def of this.defs) {
      if (!groups.has(def.cat)) groups.set(def.cat, []);
      groups.get(def.cat).push(def);
    }
    return [...groups].map(([id, list]) => ({
      id,
      ...(this.categories[id] || { label: id, emoji: '•' }),
      list,
      done: list.filter(d => this.isUnlocked(d.id)).length,
    }));
  }
}
