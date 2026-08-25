/**
 * Panels.js
 * ------------------------------------------------------------------
 * Los paneles que dan ritmo a la partida: encargos, dilemas, parte de
 * noticias y el aviso del ciclo económico.
 *
 * Están juntos porque los cuatro contestan a la misma pregunta —«¿y ahora
 * qué hago?»— que era justo la que el juego dejaba sin responder: se
 * construían dos cosas, se veía que había que esperar, y se acababa el
 * interés.
 *
 * Se montan con una fábrica en vez de importarse sueltos porque todos
 * necesitan el mismo puñado de cosas (motor, ciudad, incidencias, la
 * interfaz y cómo guardar), y pasárselo por parámetro a cada llamada
 * ensuciaba boot.js sin ganar nada.
 * ------------------------------------------------------------------
 */

import { money, onClick } from './Ui.js';

export function makePanels(ctx) {
  const { engine, ui, incidents, refresh, save } = ctx;
  const $ = (s) => document.querySelector(s);

  /* ============================ ENCARGOS =========================== */

  function goalLabel(def, v) {
    const t = (def.goal || {}).type;
    return (t === 'passive' || t === 'cash') ? money(v) : String(v);
  }

  /** La tira bajo el indicador. Siempre visible, diga lo que diga. */
  function renderQuest() {
    const el = $('#quest');
    if (!el) return;
    const c = engine.contract;
    el.hidden = false;

    if (!c) {
      el.classList.remove('done');
      el.querySelector('.q-em').textContent = '🎯';
      el.querySelector('.q-tx b').textContent = 'Coge un encargo';
      el.querySelector('.q-tx i').textContent = 'Un objetivo con recompensa';
      el.querySelector('.q-bar u').style.width = '0%';
      return;
    }

    const prog = engine.contractProgress();
    const done = engine.contractDone();
    const meses = engine.contractMonthsLeft();
    el.classList.toggle('done', done);
    el.querySelector('.q-em').textContent = done ? '✅' : (c.def.emoji || '🎯');
    el.querySelector('.q-tx b').textContent = c.def.title;
    el.querySelector('.q-tx i').textContent = done
      ? 'Cumplido · toca para cobrar'
      : goalLabel(c.def, prog) + ' de ' + goalLabel(c.def, c.goal)
        + ' · quedan ' + meses + (meses === 1 ? ' mes' : ' meses');
    el.querySelector('.q-bar u').style.width =
      Math.min(100, prog / Math.max(1, c.goal) * 100) + '%';
  }

  function showQuests() {
    const c = engine.contract;

    if (c && engine.contractDone()) {
      const r = engine.claimContract();
      ui.toast(r.ok ? 'Encargo cumplido · +' + money(r.cash) : r.reason, 'good');
      refresh(); save();
      return;
    }

    if (c) {
      ui.open((c.def.emoji || '🎯') + ' ' + c.def.title, '<div class="detail">'
        + '<p style="margin:0;color:var(--dim);font-size:13px">'
        + c.def.desc.replace('{n}', goalLabel(c.def, c.goal)) + '</p>'
        + '<div class="stats">'
        + ui.stat('Llevas', goalLabel(c.def, engine.contractProgress()))
        + ui.stat('Objetivo', goalLabel(c.def, c.goal))
        + ui.stat('Plazo', engine.contractMonthsLeft() + ' meses')
        + ui.stat('Recompensa', c.def.rewardText || '—', 'g')
        + '</div><div class="acts">'
        + '<button class="btn danger" data-drop="1">Renunciar al encargo</button>'
        + '</div></div>');
      onClick(ui.body, '[data-drop]', () => {
        engine.dropContract(); ui.close(); refresh(); save();
      });
      return;
    }

    // contractOffers() devuelve {def, goal, months}, no el def suelto: el
    // objetivo ya viene calculado y no hay que volver a pedirlo.
    const offers = engine.contractOffers();
    const body = ui.open('🎯 Encargos', offers.length
      ? '<div class="detail"><div class="acts">' + offers.map(o =>
        '<button class="btn ghost inc-opt" data-take="' + o.def.id + '">'
        + '<span class="io-l">' + (o.def.emoji || '🎯') + ' ' + o.def.title + '</span>'
        + '<span class="io-e"><span>'
        + o.def.desc.replace('{n}', goalLabel(o.def, o.goal))
        + '</span></span>'
        + '<span class="io-e"><span class="g">' + (o.def.rewardText || '') + '</span>'
        + '<span>⏳ ' + o.months + ' meses</span></span>'
        + '</button>').join('') + '</div></div>'
      : '<div class="empty">Ahora mismo no hay encargos para ti.'
        + '<br>Construye algo y vuelve.</div>');

    onClick(body, '[data-take]', (b) => {
      const def = engine.contractDefs().find(d => d.id === b.dataset.take);
      const r = engine.acceptContract(def);
      ui.toast(r.ok ? 'Encargo aceptado' : r.reason, r.ok ? 'good' : 'bad');
      ui.close(); refresh(); save();
    });
  }

  /* =========================== DILEMAS ============================= */

  /**
   * Las cifras de cada opción se enseñan ANTES de elegir. Sin ellas,
   * elegir es adivinar, y adivinando no se aprende nada: la gracia de un
   * dilema es ver qué estás cambiando por qué.
   */
  function effectBits(c) {
    const bits = [];
    const sign = (n) => (n > 0 ? '+' : '');
    const cls = (n) => (n > 0 ? 'g' : 'r');
    if (c.cash) bits.push('<span class="' + cls(c.cash) + '">' + sign(c.cash) + money(c.cash) + '</span>');
    if (c.happiness) bits.push('<span class="' + cls(c.happiness) + '">😊 ' + sign(c.happiness) + c.happiness + '</span>');
    if (c.energy) bits.push('<span class="' + cls(c.energy) + '">⚡ ' + sign(c.energy) + c.energy + '</span>');
    if (c.salaryBoost) bits.push('<span class="g">Sueldo +' + Math.round(c.salaryBoost * 100) + '%</span>');
    return bits.length ? bits.join('') : '<span>Sin coste</span>';
  }

  function showDilemma() {
    const item = incidents.next();
    if (!item) return false;
    const ev = item.ev;

    const body = ui.open('Tienes que decidir', '<div class="detail">'
      + '<div class="inc-hero"><span class="inc-em">🤔</span><div>'
      + '<h3 style="margin:0 0 3px;font-size:16px">' + ev.title + '</h3>'
      + '<p style="margin:0;font-size:13px;color:var(--dim)">' + ev.description + '</p>'
      + '</div></div><div class="acts">'
      + ev.choices.map((c, i) =>
        '<button class="btn ghost inc-opt" data-choice="' + i + '">'
        + '<span class="io-l">' + c.label + '</span>'
        + '<span class="io-e">' + effectBits(c) + '</span></button>').join('')
      + '</div></div>');

    onClick(body, '[data-choice]', (b) => {
      incidents.resolve(item.uid, Number(b.dataset.choice));
      ui.close(); refresh(); save();
    });
    return true;
  }

  /* ========================== EL PARTE ============================= */

  function showNews() {
    const f = incidents.feed;
    ui.open('📰 Tu ciudad', f.length
      ? '<div class="news">' + f.map(n =>
        '<div class="news-i ' + (n.tone || '') + '"><div>'
        + '<div class="n-t">' + n.title + '</div>'
        + '<div class="n-d">' + (n.text || '')
        + (n.covered ? ' · el seguro cubrió ' + money(n.covered) : '') + '</div>'
        + '</div>'
        + (n.cash ? '<div class="n-c ' + (n.cash > 0 ? 'g' : 'r') + '">'
          + (n.cash > 0 ? '+' : '') + money(n.cash) + '</div>' : '')
        + '</div>').join('') + '</div>'
      : '<div class="empty">Todo tranquilo por ahora.</div>');
  }

  /* ======================= CICLO ECONÓMICO ========================= */

  /**
   * Comprar barato en recesión y caro en euforia es de las lecciones más
   * caras de la vida real. El motor ya mueve los precios con el ciclo; lo
   * que faltaba era decirlo donde se decide, que es la tienda.
   */
  function cycleBanner() {
    const f = engine.cyclePhase() || {};
    const mult = engine.cyclePriceMult();
    const barato = mult < 0.98;
    const caro = mult > 1.02;
    const pct = Math.round(Math.abs(1 - mult) * 100);
    const consejo = barato
      ? 'Los activos están un ' + pct + '% más baratos. Es cuando conviene entrar.'
      : caro
        ? 'Los activos están un ' + pct + '% más caros. Comprar hoy sale peor.'
        : 'Precios en su sitio.';
    return '<div class="cyc ' + (barato ? 'cheap' : caro ? 'dear' : '') + '">'
      + '<span class="c-em">' + (f.emoji || '🌤️') + '</span><div>'
      + '<div class="c-t">' + (f.label || 'Mercado') + '</div>'
      + '<div class="c-d">' + consejo + '</div></div></div>';
  }

  return { renderQuest, showQuests, showDilemma, showNews, cycleBanner };
}
