/**
 * School.js
 * ------------------------------------------------------------------
 * La Escuela: el manual consultable del juego.
 *
 * El guiado enseña a JUGAR. Esto enseña de qué va. Son cosas distintas y
 * por eso están separadas: soltar veinte pantallas sobre IRPF y
 * apalancamiento al empezar es donde la gente abandona, y además esos
 * conceptos no significan nada cuando todavía no tienes ni un activo.
 *
 * La idea que lo sostiene: **una ficha se abre cuando el concepto te
 * acaba de pasar por encima**. La del colchón salta cuando tu colchón
 * baja de tres meses; la del apalancamiento, cuando tu primer activo
 * hipotecado se revaloriza. En ese momento se lee. La misma ficha en un
 * menú de ayuda, no.
 *
 * Las condiciones viven aquí y no en el JSON porque son funciones sobre
 * el estado del motor, y meter código en un fichero de datos solo sirve
 * para tener que inventarse un intérprete.
 * ------------------------------------------------------------------
 */

const KEY = 'freedomcash.school.v1';

/** Condiciones de apertura, evaluadas contra la partida en curso. */
const WHEN = {
  always: () => true,

  hasMortgage: ({ engine }) =>
    engine.ownedAssets.some(a => a.financing === 'leverage'),

  hasLeveraged: ({ engine }) =>
    engine.ownedAssets.some(a => a.financing === 'leverage'
      && engine.appreciationPct(a) > 0),

  thinCushion: ({ engine }) =>
    engine.ownedAssets.length > 0 && engine.cashCushionMonths() < 3,

  inflationBiting: ({ engine }) => engine.expenseInflation > 1.10,

  hasVacancy: ({ engine }) => engine.ownedAssets.some(a => engine.isVacant(a)),

  richPassive: ({ engine }) => engine.totalPassiveIncome() > 2000,

  /** Más del 70 % de la renta, en una sola categoría. */
  concentrated: ({ engine }) => {
    const total = engine.totalPassiveIncome();
    if (total < 500) return false;
    const by = {};
    engine.ownedAssets.forEach(a => {
      by[a.category] = (by[a.category] || 0) + engine.assetNetIncome(a);
    });
    return Object.values(by).some(v => v / total > 0.7);
  },
};

export class School {
  /**
   * @param {object} data  contenido de school.json
   * @param {Ui} ui
   */
  constructor(data, ui) {
    this.cards = data.cards || [];
    this.ui = ui;
    this.opened = new Set(load());
    this.seen = new Set(load('seen'));
  }

  /**
   * Comprueba qué fichas se han ganado el derecho a abrirse.
   * @returns {object[]} las que se acaban de desbloquear
   */
  check(ctx) {
    const fresh = [];
    for (const c of this.cards) {
      if (this.opened.has(c.id)) continue;
      const test = WHEN[c.when];
      if (!test) continue;
      let ok = false;
      try { ok = test(ctx); } catch (e) { ok = false; }
      if (!ok) continue;
      this.opened.add(c.id);
      fresh.push(c);
    }
    if (fresh.length) save([...this.opened]);
    return fresh;
  }

  /** Fichas desbloqueadas y todavía sin leer. */
  get unread() {
    return [...this.opened].filter(id => !this.seen.has(id)).length;
  }

  markSeen(id) {
    this.seen.add(id);
    save([...this.seen], 'seen');
  }

  /* ---------------------------- VISTA ---------------------------- */

  /** El índice: lo desbloqueado arriba, lo pendiente en gris abajo. */
  list() {
    const ui = this.ui;
    const item = (c, open) => {
      const unread = open && !this.seen.has(c.id);
      return `<button class="btn ghost sc-item${open ? '' : ' locked'}"
          ${open ? `data-card="${c.id}"` : 'disabled'}>
        <span class="sc-ic">${open ? c.icon : '🔒'}</span>
        <span class="sc-tx"><b>${c.title}</b><br>
        <small>${open ? c.lead : 'Se abrirá cuando te toque de cerca'}</small></span>
        ${unread ? '<i class="sc-dot"></i>' : ''}
      </button>`;
    };

    const open = this.cards.filter(c => this.opened.has(c.id));
    const shut = this.cards.filter(c => !this.opened.has(c.id));
    const body = ui.open('🎓 La Escuela', `<div class="detail">
      <div class="acts">${open.map(c => item(c, true)).join('')}</div>
      ${shut.length ? `<div class="acts" style="margin-top:6px">
        ${shut.map(c => item(c, false)).join('')}</div>` : ''}
    </div>`);
    return body;
  }

  /** Una ficha, con su cuerpo desplegado. */
  card(id) {
    const c = this.cards.find(x => x.id === id);
    if (!c) return null;
    this.markSeen(id);
    const body = this.ui.open(c.icon + ' ' + c.title, `<div class="detail sc-read">
      <p class="sc-lead">${c.lead}</p>
      ${c.body.map(p => `<p>${p}</p>`).join('')}
      <div class="acts"><button class="btn ghost" data-back="1">Volver</button></div>
    </div>`);
    return body;
  }
}

/* ------------------------- PERSISTENCIA -------------------------- */

function load(suffix = '') {
  try {
    return JSON.parse(localStorage.getItem(KEY + (suffix ? '.' + suffix : '')) || '[]');
  } catch (e) { return []; }
}

function save(list, suffix = '') {
  try {
    localStorage.setItem(KEY + (suffix ? '.' + suffix : ''), JSON.stringify(list));
  } catch (e) { /* cuota llena o modo privado: no es motivo para romper nada */ }
}
