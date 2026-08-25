/**
 * boot.js
 * ------------------------------------------------------------------
 * Arranque y pegamento: carga los datos, monta el motor económico, la
 * ciudad y el reloj, y conecta la escena de Phaser con la interfaz.
 *
 * El reparto de responsabilidades es el de siempre y conviene respetarlo:
 *
 *   EconomyEngine  cuánto renta, cuánto cuesta, cuánto se paga de
 *                  impuestos. Sigue siendo la única fuente de verdad
 *                  económica y no sabe que existe una ciudad.
 *   City           dónde está cada edificio y cuándo toca cobrarlo.
 *   Clock          cuándo pasa un mes, incluso con el juego cerrado.
 *   CityScene      cómo se ve y cómo responde al dedo.
 *   este fichero   quién le dice qué a quién.
 * ------------------------------------------------------------------
 */

import Phaser from '../vendor/phaser.js';
import { EconomyEngine } from './engine/EconomyEngine.js';
import { City } from './game/City.js';
import { Clock, fmtDuration } from './game/Clock.js';
import { CityScene } from './scenes/CityScene.js';
import { Ui, money, short, onClick } from './ui/Ui.js';
import { tierRules, MATERIAL_PLANTS, CIVIC, buildersAt } from './game/rules.js';
import { URBANIZE_COST, URBANIZE_MATERIALS } from './game/City.js';
import { OFFLINE_WELLBEING_FLOOR } from './game/rules.js';
import { bus } from './game/Bus.js';
import { Incidents, NO_EVENT } from './game/Incidents.js';
import { Guide } from './ui/Guide.js';
import { School } from './ui/School.js';
import { Achievements } from './engine/Achievements.js';
import { makePanels } from './ui/Panels.js';

const SAVE_KEY = 'freedomcash.city.v1';
const $ = (s) => document.querySelector(s);

const DATA = {};
let engine, city, clock, scene, game, ui, models, school, guide, incidents, panels, ach;

/* ============================== CARGA ============================== */

const loadJSON = (p) => fetch(p, { cache: 'no-cache' }).then(r => r.json());

async function loadAll() {
  const files = ['assets_database', 'profiles', 'events', 'difficulty',
    'professions', 'tax', 'insurance', 'contracts', 'models', 'school', 'lifestyle', 'achievements'];
  const [atlas, ...rest] = await Promise.all([
    loadJSON('assets/atlas/sprites.json'),
    ...files.map(f => loadJSON(`src/data/${f}.json`)),
  ]);
  files.forEach((f, i) => { DATA[f] = rest[i]; });
  DATA.atlas = atlas;
  models = DATA.models.models;
}

/* ============================ ESCALONES ============================ */

/** Nivel de ciudad a partir del cual se desbloquea cada escalón. */
const TIER_LEVEL = [0, 1, 2, 4, 7, 10];

function modelOf(assetId) {
  return models[assetId] || { sprite: 'house_02', tier: 1 };
}

function spriteOf(asset) { return modelOf(asset.baseId || asset.id).sprite; }
function tierOf(asset) { return modelOf(asset.baseId || asset.id).tier; }

/* ============================ ARRANQUE ============================= */

async function main() {
  await loadAll();
  ui = new Ui(DATA.atlas);
  school = new School(DATA.school, ui);
  ach = new Achievements(DATA.achievements);
  wireDock();

  const save = loadSave();
  if (save) return showResume(save);
  showProfiles();
}

/* --------------------------- ONBOARDING ---------------------------- */
/*
 * Tres pantallas de tarjetas ilustradas en vez de un modal con párrafos.
 * Las decisiones son las mismas de siempre —situación, oficio y
 * dificultad—, pero se eligen mirando, no leyendo.
 */

function obStep(html) { $('.ob-steps').innerHTML = html; }

function showResume(save) {
  obStep(`
    <button class="ob-opt" data-go="resume">
      <span class="em">⏱️</span>
      <span><span class="tt">Seguir construyendo</span>
      <span class="dd">Nivel ${save.city.level} · ${save.city.plots.length} parcelas</span></span>
    </button>
    <button class="ob-opt" data-go="new">
      <span class="em">✨</span>
      <span><span class="tt">Empezar de cero</span>
      <span class="dd">Se borra la ciudad actual</span></span>
    </button>`);
  $('.ob-steps').onclick = (e) => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    if (b.dataset.go === 'resume') resumeGame(save);
    else { stopSaving = false; localStorage.removeItem(SAVE_KEY); showProfiles(); }
  };
}

function showProfiles() {
  $('.ob-card h1').textContent = 'Tu punto de partida';
  $('.ob-lead').textContent = 'De cuánto dispones y cuánto te cuesta vivir.';
  obStep(DATA.profiles.profiles.map(p => `
    <button class="ob-opt" data-id="${p.id}">
      <span class="em">${p.emoji}</span>
      <span><span class="tt">${p.name}</span>
      <span class="dd">${money(p.salary_base)}/mes · gastos ${money(p.fixed_expenses)} · caja ${money(p.starting_cash)}</span></span>
    </button>`).join(''));
  $('.ob-steps').onclick = (e) => {
    const b = e.target.closest('[data-id]');
    if (b) showProfessions(DATA.profiles.profiles.find(p => p.id === b.dataset.id));
  };
}

function showProfessions(profile) {
  $('.ob-card h1').textContent = 'Tu oficio';
  $('.ob-lead').textContent = 'Abre proyectos que los demás no pueden tocar.';
  const list = [{ id: 'none', emoji: '🎲', name: 'Sin especializar', desc: 'Acceso al catálogo general.' }]
    .concat(DATA.professions.professions);
  obStep(list.map(p => `
    <button class="ob-opt" data-id="${p.id}">
      <span class="em">${p.emoji || '🧰'}</span>
      <span><span class="tt">${p.name}</span><span class="dd">${p.desc || ''}</span></span>
    </button>`).join(''));
  $('.ob-steps').onclick = (e) => {
    const b = e.target.closest('[data-id]');
    if (b) showDifficulty(profile, b.dataset.id);
  };
}

function showDifficulty(profile, professionId) {
  $('.ob-card h1').textContent = 'Cuánto aprieta';
  $('.ob-lead').textContent = 'Puedes cambiar de idea empezando otra ciudad.';
  obStep(DATA.difficulty.modes.map(m => `
    <button class="ob-opt" data-id="${m.id}">
      <span class="em">${m.emoji}</span>
      <span><span class="tt">${m.label}</span><span class="dd">${m.desc}</span></span>
    </button>`).join(''));
  $('.ob-steps').onclick = (e) => {
    const b = e.target.closest('[data-id]');
    if (b) startGame(profile, DATA.difficulty.modes.find(m => m.id === b.dataset.id), professionId);
  };
}

/* ============================ PARTIDA ============================== */

function buildEngine(profile, mode, professionId) {
  const e = new EconomyEngine(profile, DATA.events.events, mode);
  e.professionId = professionId || 'none';
  e.setTaxData(DATA.tax);
  e.setInsuranceData(DATA.insurance);
  e.setContractData(DATA.contracts);
  return e;
}

function startGame(profile, mode, professionId) {
  engine = buildEngine(profile, mode, professionId);
  // Cada partida, su isla. La semilla se guarda y no vuelve a tocarse:
  // el contorno tiene que ser el mismo mañana o un edificio ya construido
  // podría amanecer en el agua.
  ach.newRun();
  ach.bumpLife('games');
  const seed = (Math.random() * 0xffffffff) >>> 0 || 1;
  city = new City(engine, DATA.models, DATA.atlas, seed);
  city.sprinkleScenery(24);
  incidents = new Incidents(engine, city, bus);
  clock = new Clock(runPeriod);
  launch();
}

function resumeGame(save) {
  const profile = DATA.profiles.profiles.find(p => p.id === save.engine.profileId)
    || DATA.profiles.profiles[0];
  engine = EconomyEngine.fromJSON(save.engine, profile, DATA.events.events);
  engine.setTaxData(DATA.tax);
  engine.setInsuranceData(DATA.insurance);
  engine.setContractData(DATA.contracts);
  city = new City(engine, DATA.models, DATA.atlas, save.city.seed || 1);
  city.load(save.city);
  incidents = new Incidents(engine, city, bus);
  incidents.load(save.incidents);
  clock = new Clock(runPeriod);
  clock.load(save.clock);
  launch(true);
}

function launch(resumed = false) {
  $('#onboard').hidden = true;

  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'stage',
    backgroundColor: '#6f9a63',
    scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.NO_CENTER },
    render: { antialias: true, roundPixels: false, powerPreference: 'high-performance' },
    scene: [],
  });

  /*
   * La escena se añade con sus datos y se espera a que ella avise de que
   * está lista. Phaser arranca de forma asíncrona: preguntar por la
   * escena justo después de pedir que empiece devuelve null, y todo lo
   * que dependa de esa referencia —colocar un edificio, refrescar una
   * parcela— falla sin decir nada, porque solo se ejecuta al interactuar.
   */
  game.scene.add('city', CityScene, true, {
    city, atlas: DATA.atlas,
    onTapPlot: showPlot,
    onTapEmpty: tapEmpty,
    onHoldPlot: startMove,
    onReady: (s) => { scene = s; window.FC.scene = s; sceneReady(resumed); },
  });

  // Enganche de depuración: permite inspeccionar y forzar estados desde la
  // consola sin tener que jugar media hora para llegar a la situación.
  panels = makePanels({
    engine, city, ui, incidents,
    lifestyle: DATA.lifestyle.actions,
    assetById: (id) => DATA.assets_database.assets.find(a => a.id === id),
    spriteOf, tierOf, tierRules,
    onCityChange: () => { scene.syncViews(); scene.refreshTerrain(); },
    onMerge: () => { ach.bumpRun('merges'); ach.bumpLife('merges'); },
    onContractDone: () => { ach.bumpRun('contracts'); ach.bumpLife('contracts'); },
    onLifestyle: () => ach.bumpLife('lifestyle_actions'),
    refresh: renderHud, save,
  });

  window.FC = { engine, city, clock, scene: null, ui, game, DATA, incidents, panels };
}

function sceneReady(resumed) {
  // Los meses pendientes se recuperan al entrar: en un builder, media
  // partida transcurre con el juego cerrado.
  const missed = clock.catchUp();
  if (resumed && missed.length) reportOffline(missed);

  checkSchool();
  if (!resumed && !Guide.done) {
    guide = new Guide({ bus, city, scene, ui }, () => { guide = null; });
  }

  setInterval(tick, 1000);
  setInterval(save, 15000);
  window.addEventListener('beforeunload', save);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { clock.catchUp(); tick(); }
    else save();
  });
  tick();
}

/* ============================== BUCLE ============================== */

/**
 * Un mes del motor. No lo dispara el jugador: lo dispara el reloj.
 *
 * Se le pasa un evento VACÍO a propósito. endTurn() sorteaba y resolvía
 * uno él solo, y con el mes convertido en dos horas de reloj eso
 * significaba que cada dos horas pasaba algo que el jugador no llegaba a
 * ver nunca. Ahora los eventos los reparte Incidents: los dilemas esperan
 * a que decidas y el resto deja rastro.
 */
function runPeriod(i, total) {
  const antesH = engine.happiness, antesE = engine.energy;
  const snap = engine.endTurn(NO_EVENT);
  engine.actionsUsed = 0;         // aquí el freno son los constructores
  engine.lifestyleUsed = new Set();

  /*
   * Recuperando meses de golpe, el desgaste se frena en un suelo: estando
   * fuera el jugador no puede descansar ni salir a cenar, y dejar que siga
   * bajando seria castigarle por cerrar la pestana. Delante de la pantalla
   * no hay suelo, porque ahi si puede hacer algo.
   */
  if (total > 1) {
    if (engine.happiness < antesH) {
      engine.happiness = Math.max(engine.happiness, Math.min(antesH, OFFLINE_WELLBEING_FLOOR));
    }
    if (engine.energy < antesE) {
      engine.energy = Math.max(engine.energy, Math.min(antesE, OFFLINE_WELLBEING_FLOOR));
    }
  }
  return snap;
}

function tick() {
  clock.catchUp();
  incidents.catchUp();
  const done = city.tickBuilds();
  const before = city.level;
  done.forEach(p => {
    scene.refresh(p.uid);
    scene.popBuilt(p);
    city.addXp(4 * p.tier);
    bus.emit('build:done', { plot: p });
  });
  if (done.length) {
    ui.toast(done.length === 1 ? 'Obra terminada' : `${done.length} obras terminadas`, 'good');
  }
  if (city.level > before) {
    scene.refreshTerrain();
    bus.emit('level:up', { level: city.level });
    ui.toast(`Nivel ${city.level}. Se abre una manzana nueva.`, 'good');
  }
  checkSchool();
  checkAchievements();
  if (incidents.tickMarks()) scene.syncViews();

  // Un dilema se ensena en cuanto hay hueco. Esperando a que el jugador
  // abra un menu, se quedaria ahi para siempre y la decision se perderia.
  if (incidents.waiting && !ui.isOpen && !scene.placing && !guide) {
    panels.showDilemma();
  }
  renderHud();
}

function reportOffline(snaps) {
  const got = city.list().reduce((s, p) => s + city.pending(p).cash, 0);
  ui.toast(`Han pasado ${snaps.length} ${snaps.length === 1 ? 'mes' : 'meses'}` +
    (got > 0 ? ` · ${money(got)} esperándote` : ''), 'good');
}

/* ============================= ESCUELA ============================= */

/**
 * Una ficha se abre cuando el concepto acaba de pasarte por encima: la
 * del colchon cuando el tuyo baja de tres meses, la del apalancamiento
 * cuando tu primer activo hipotecado se revaloriza. En ese momento se
 * lee; la misma ficha en un menu de ayuda, no.
 */
function checkSchool() {
  const fresh = school.check({ engine, city });
  if (fresh.length && !ui.isOpen) {
    ui.toast(`Nueva ficha en la Escuela: ${fresh[0].title}`, 'good');
  }
}

function showSchool() {
  const body = school.list();
  onClick(body, '[data-card]', (b) => openCard(b.dataset.card));
}

function openCard(id) {
  const body = school.card(id);
  if (body) onClick(body, '[data-back]', () => showSchool());
  renderHud();
}

/* ============================= LOGROS ============================== */

/**
 * Valores de ESTA partida que los logros consultan y que no salen de
 * status(): cosas sobre la FORMA de la cartera, no sobre sus cifras.
 */
function achDerived() {
  const owned = engine.ownedAssets.filter(a => !a.ruined);
  const porCat = {};
  owned.forEach(a => { porCat[a.category] = (porCat[a.category] || 0) + 1; });
  const counts = Object.values(porCat);

  return {
    ...ach.run,
    categories_owned: Object.keys(porCat).length,
    max_category_count: counts.length ? Math.max(...counts) : 0,
    leveraged_count: owned.filter(a => a.financing === 'leverage').length,
    financial_count: owned.filter(a => a.category === 'financial').length,
    policies_active: engine.insurance.size,
    red_loans: engine.redDebts.length,
    ruins: engine.ownedAssets.filter(a => a.ruined).length,
    booms: owned.reduce((n, a) => n + (a.boomed || 0), 0),
  };
}

function checkAchievements() {
  if (!ach) return;
  if (engine.cash < 0) ach.setRun('was_negative', 1);
  if (engine.isBurnout()) ach.setRun('burnouts', 1);

  const fresh = ach.evaluate(engine.status(), achDerived());
  // se encadenan: si caen tres de golpe, uno tapaba al siguiente
  fresh.forEach((def, i) => setTimeout(() => celebrate(def), i * 2200));
}

/** Un logro merece pararse un segundo. Si no, no es un premio. */
function celebrate(def) {
  const t = (DATA.achievements.tiers || {})[def.tier] || {};
  const el = $('#trophy');
  if (!el) return;
  el.querySelector('.tr-em').textContent = def.emoji;
  el.querySelector('.tr-t').textContent = def.title;
  el.querySelector('.tr-d').textContent = def.desc;
  const tier = el.querySelector('.tr-tier');
  tier.textContent = t.label || '';
  tier.style.color = t.color || 'var(--gold)';
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 4200);
}

function showTrophies() {
  const p = ach.progress();
  const grupos = ach.byCategory().map(g =>
    '<div class="tg-h">' + (g.emoji || '\u2022') + ' ' + (g.label || g.id)
    + ' <i>' + g.done + '/' + g.list.length + '</i></div>'
    + '<div class="tg">' + g.list.map(d => {
      const on = ach.isUnlocked(d.id);
      const t = (DATA.achievements.tiers || {})[d.tier] || {};
      return '<div class="tr-i' + (on ? '' : ' off') + '"'
        + (on ? ' style="border-color:' + (t.color || '#555') + '66"' : '') + '>'
        + '<span class="tr-i-em">' + (on ? d.emoji : '\u{1F512}') + '</span>'
        + '<span class="tr-i-tx"><b>' + d.title + '</b><br><small>' + d.desc + '</small></span>'
        + '</div>';
    }).join('') + '</div>').join('');

  ui.open('\u{1F3C5} Logros', '<div class="detail">'
    + '<div class="stats">'
    + ui.stat('Conseguidos', p.unlocked + ' de ' + p.total)
    + ui.stat('Puntos', p.points + ' de ' + p.maxPoints)
    + '</div>' + grupos + '</div>');
}

/* =============================== HUD =============================== */

function renderHud() {
  const s = engine.status ? engine.status() : {};
  $('#res-cash b').textContent = short(engine.cash);
  $('#res-mat b').textContent = city.materials;
  $('#res-mat .cap').textContent = '/' + city.materialCap();
  $('#res-mat').classList.toggle('full', city.materialsFull());
  const wb = $('#res-wb');
  if (wb) {
    wb.querySelector('.wb-h').textContent = Math.round(engine.happiness);
    wb.querySelector('.wb-e').textContent = Math.round(engine.energy);
    wb.classList.toggle('burn', engine.isBurnout());
  }
  $('#res-lvl b').textContent = city.level;
  $('#res-lvl .xp i').style.width = Math.min(100, city.xp / city.xpNeeded() * 100) + '%';

  const ie = engine.emancipationIndex();
  const target = engine.winTargetIE();
  $('#ie .ie-bar i').style.width = Math.min(100, ie / target * 100) + '%';
  $('#ie .ie-bar u').style.left = '100%';
  $('#ie .ie-txt').innerHTML = `<b>${Math.round(ie)}%</b> de ${Math.round(target)}%`;

  // Insignias del dock: cuánto hay que cobrar y cuántas obras hay en marcha
  const ready = city.list().filter(p => city.pending(p).ready).length;
  badge('#dk-collect', ready);
  $('#dk-collect').classList.toggle('hot', ready > 0);
  badge('#dk-builders', city.building().length);
  badge('#dk-menu', (school ? school.unread : 0) + (incidents ? incidents.waiting : 0));
  if (panels) panels.renderQuest();
}

function badge(sel, n) {
  const el = $(sel + ' .badge');
  el.textContent = n;
  el.hidden = n <= 0;
}

/* ============================== DOCK =============================== */

function wireDock() {
  $('#dk-shop').onclick = showShop;
  $('#dk-collect').onclick = collectAll;
  $('#dk-builders').onclick = showBuilders;
  $('#dk-menu').onclick = showMenu;
  $('#ie').onclick = showFreedom;
  $('#quest').onclick = () => panels.showQuests();
}

function collectAll() {
  const got = city.collectAll();
  if (!got.count) return ui.toast('Nada que cobrar todavía');
  if (got.cash) ui.toast(`+${money(got.cash)}`, 'good');
  else if (got.materials) ui.toast(`+${got.materials} 🧱`, 'good');
  renderHud();
  bus.emit('collect', { plot: null, ...got });
}

/* ============================== TIENDA ============================= */
/*
 * Sustituye al Marketplace de cuatro huecos. En un builder el catálogo
 * está siempre disponible y lo que te frena es el nivel, los materiales y
 * los constructores libres, no que la oferta caduque.
 */

function catalogFor() {
  return DATA.assets_database.assets
    .filter(a => engine.assetEligible(a))
    .filter(a => TIER_LEVEL[tierOf(a)] <= city.level)
    .sort((a, b) => a.financials.total_price - b.financials.total_price);
}

function showShop() {
  bus.emit('shop:open');
  const plants = MATERIAL_PLANTS.filter(p => p.minLevel <= city.level);
  const body = ui.open('Construir', `
    ${panels.cycleBanner()}
    ${panels.upgradeCards()}
    <div class="cards" id="shop-plants">${plants.map(plantCard).join('')}</div>
    <div style="height:14px"></div>
    <div class="cards" id="shop-assets">${catalogFor().map(assetCard).join('')}</div>`);

  onClick(body, '[data-up]', (b) => panels.doUpgrade(b.dataset.up));
  onClick(body, '#shop-plants .go', (b) => beginPlant(b.dataset.plant));
  onClick(body, '#shop-assets .go', (b) => chooseFinancing(b.dataset.asset));
}

function plantCard(p) {
  const can = engine.cash >= p.cost && city.buildersFree() > 0;
  return ui.card({
    sprite: p.sprite, title: p.name,
    facts: `<span><b>${money(p.cost)}</b></span>
            <span class="g">+${p.perCycle}🧱</span>
            <span>⏱ ${fmtDuration(p.buildMs)}</span>`,
    action: can ? 'Construir' : (city.buildersFree() ? 'Sin caja' : 'Sin obreros'),
    disabled: !can, ghost: true, data: { plant: p.id },
  });
}

function assetCard(a) {
  const t = tierOf(a);
  const r = tierRules(t);
  const f = engine.pricedFinancials(a);
  const band = engine.incomeBand({ ...a, financials: f });
  const canMat = city.materials >= r.materials;
  const canBuild = city.buildersFree() > 0;
  const canPay = engine.cash >= (a.leverage_allowed ? f.down_payment_required : f.total_price);
  const ok = canMat && canBuild && canPay;
  return ui.card({
    sprite: spriteOf(a), title: a.title,
    facts: `<span><b>${money(a.leverage_allowed ? f.down_payment_required : f.total_price)}</b></span>
            <span class="${band.expected >= 0 ? 'g' : 'r'}">${band.expected >= 0 ? '+' : ''}${money(band.expected)}/mes</span>
            <span>🧱${r.materials}</span>
            <span>⏱ ${fmtDuration(r.buildMs)}</span>`,
    action: ok ? 'Construir' : !canBuild ? 'Sin obreros' : !canMat ? 'Faltan 🧱' : 'Sin caja',
    disabled: !ok, data: { asset: a.id },
  });
}

/**
 * La elección entre pagar al contado o con hipoteca es el corazón
 * didáctico del juego, así que no se esconde en un desplegable: son dos
 * botones grandes con lo que cuesta cada uno.
 */
function chooseFinancing(assetId) {
  const a = DATA.assets_database.assets.find(x => x.id === assetId);
  if (!a) return;
  const f = engine.pricedFinancials(a);
  const t = tierOf(a);
  const r = tierRules(t);

  const opts = [{
    key: 'cash', label: 'Al contado', sub: 'Sin deuda, sin cuota',
    cost: f.total_price, ok: engine.cash >= f.total_price,
  }];
  if (a.leverage_allowed) {
    opts.push({
      key: 'leverage', label: 'Con hipoteca',
      sub: `Entras con menos, pagas ${money(f.monthly_mortgage_cost)}/mes`,
      cost: f.down_payment_required, ok: engine.cash >= f.down_payment_required,
    });
  }

  const body = ui.open(a.title, `
    <div class="detail">
      <div class="hero">${ui.thumb(spriteOf(a), 96)}
        <div><h3>${a.title}</h3><p>${a.description || ''}</p></div></div>
      <div class="stats">
        ${ui.stat('Renta esperada', money(engine.incomeBand({ ...a, financials: f }).expected) + '/mes', 'g')}
        ${ui.stat('Obra', fmtDuration(r.buildMs))}
        ${ui.stat('Materiales', r.materials + ' 🧱', city.materials >= r.materials ? '' : 'r')}
        ${ui.stat('Cobro cada', fmtDuration(r.cycleMs))}
      </div>
      <div class="acts">
        ${opts.map(o => `<button class="btn${o.key === 'cash' ? ' ghost' : ''}" data-fin="${o.key}"
          ${o.ok ? '' : 'disabled'}>${o.label} · ${money(o.cost)}<br>
          <small style="opacity:.7;font-weight:400">${o.sub}</small></button>`).join('')}
      </div>
    </div>`);

  onClick(body, '[data-fin]', (b) => beginAsset(a, b.dataset.fin));
}

/* =========================== COLOCACIÓN ============================ */

function beginAsset(asset, financing) {
  const r = tierRules(tierOf(asset));
  if (city.buildersFree() <= 0) return ui.toast('No te quedan obreros libres', 'bad');
  if (city.materials < r.materials) return ui.toast(`Te faltan ${r.materials - city.materials} 🧱`, 'bad');
  const check = engine.canBuy(asset, financing);
  if (!check.ok) return ui.toast(check.reason || 'No puedes permitírtelo', 'bad');

  ui.close();
  ui.toast('Elige dónde va y toca para confirmar');
  scene.beginPlacement(spriteOf(asset), (col, row) => {
    const res = engine.buyAsset(asset, financing);
    if (!res.ok) return ui.toast(res.reason, 'bad');
    city.spendMaterials(r.materials);
    const plot = city.add({
      kind: 'asset', sprite: spriteOf(asset), tier: tierOf(asset),
      instanceId: res.instance.instanceId, category: asset.category,
      buildMs: r.buildMs,
    }, col, row);
    if (plot) res.instance.cell = { col: plot.col, row: plot.row };
    scene.syncViews();
    renderHud();
    bus.emit('build:placed', { plot });
    ach.bumpRun('buys');
    if (financing === 'leverage') ach.bumpLife('bought_leverage');
    save();
  }, null, { category: asset.category });
}

function beginPlant(plantId) {
  const p = MATERIAL_PLANTS.find(x => x.id === plantId);
  if (!p) return;
  if (city.buildersFree() <= 0) return ui.toast('No te quedan obreros libres', 'bad');
  if (engine.cash < p.cost) return ui.toast('Sin caja suficiente', 'bad');

  ui.close();
  ui.toast('Elige dónde va y toca para confirmar');
  scene.beginPlacement(p.sprite, (col, row) => {
    engine.cash -= p.cost;
    const plot = city.add({ kind: 'plant', plantId: p.id, sprite: p.sprite,
      category: 'digital_business', buildMs: p.buildMs }, col, row);
    scene.syncViews();
    renderHud();
    bus.emit('build:placed', { plot });
    save();
  }, null, { category: 'digital_business' });
}

/* ========================= MOVER Y DESPEJAR ======================== */

/**
 * Levantar un edificio y volver a posarlo. Se apoya en el `ignoreUid` de
 * City.isFree(), que existia sin usarse: sin el, mover una pieza a un
 * sitio que se solape con donde ya esta se rechaza por chocar consigo
 * misma, y moverla una casilla al lado seria imposible.
 */
function startMove(plot) {
  ui.close();
  ui.toast('Elige el nuevo solar');
  scene.beginPlacement(plot.sprite, (col, row) => {
    if (city.move(plot.uid, col, row)) {
      scene.refresh(plot.uid);
      scene.syncViews();
      save();
    }
  }, null, { ignoreUid: plot.uid });
}

/** Toque en el suelo: si es cesped, se puede comprar para urbanizarlo. */
function tapEmpty(cell) {
  ui.close();
  if (!city.canUrbanize(cell.col, cell.row)) return;
  const puede = engine.cash >= URBANIZE_COST && city.materials >= URBANIZE_MATERIALS;
  const body = ui.open('Urbanizar', `<div class="detail">
    <div class="stats">
      ${ui.stat('Coste', money(URBANIZE_COST), engine.cash >= URBANIZE_COST ? '' : 'r')}
      ${ui.stat('Materiales', URBANIZE_MATERIALS + ' &#129521;',
    city.materials >= URBANIZE_MATERIALS ? '' : 'r')}
    </div>
    <p style="color:var(--dim);font-size:13px;margin:0">
      Convierte esta parcela de campo en solar edificable. El suelo tambien
      es una inversion: cuesta dinero hoy y solo renta si construyes encima.</p>
    <div class="acts">
      <button class="btn" data-urb="1" ${puede ? '' : 'disabled'}>
        ${puede ? 'Urbanizar' : 'No te llega'}</button>
    </div></div>`);
  onClick(body, '[data-urb]', () => {
    if (!puede) return;
    engine.cash -= URBANIZE_COST;
    city.spendMaterials(URBANIZE_MATERIALS);
    city.urbanize(cell.col, cell.row);
    scene.refreshTerrain();
    ui.close(); renderHud(); save();
    ui.toast('Solar listo para construir', 'good');
  });
}

/* ============================== FICHA ============================== */

function showPlot(plot) {
  if (plot.kind === 'civic') return showCivic(plot.civicId);
  // El trabajo cobra al tocarlo, pero si estas quemado abre la ficha: es
  // el unico sitio donde se explica por que tu sueldo ha caido.
  if (plot.kind === 'job' && (engine.isBurnout() || !city.pending(plot).ready)) {
    return panels.showLife();
  }
  if (plot.kind === 'scenery') return showScenery(plot);

  const got = city.pending(plot);
  // Un toque sobre algo que ya tiene dinero dentro lo cobra directamente:
  // obligar a abrir una ficha para recoger sería un paso de más en el
  // gesto más repetido del juego.
  if (got.ready && plot.state === 'ready') {
    const g = city.collect(plot);
    if (g.cash) scene.popCollect(plot, '+' + money(g.cash));
    if (g.materials) scene.popCollect(plot, '+' + g.materials + ' 🧱', 'mat');
    renderHud();
    bus.emit('collect', { plot, ...g });
    return;
  }

  if (plot.state === 'building') {
    ui.open('En obra', `<div class="detail">
      <div class="hero">${ui.thumb(plot.sprite, 96)}
        <div><h3>Obra en marcha</h3>
        <p>Lista en ${fmtDuration(plot.doneAt - Date.now())}</p></div></div>
      <div class="acts"><button class="btn" data-rush="${plot.uid}">Terminar ahora</button></div>
    </div>`);
    onClick(ui.body, '[data-rush]', (b) => {
      city.finishNow(+b.dataset.rush);
      ui.close(); tick();
    });
    return;
  }

  const asset = city.assetOf(plot);
  const cyc = city.cycleOf(plot);
  ui.open(asset ? asset.title : 'Edificio', `<div class="detail">
    <div class="hero">${ui.thumb(plot.sprite, 96)}
      <div><h3>${asset ? asset.title : 'Edificio'}</h3>
      <p>Siguiente cobro en ${fmtDuration(cyc.ms - ((Date.now() - plot.collectedAt) % cyc.ms))}</p></div></div>
    <div class="stats">
      ${ui.stat('Renta neta', asset ? money(engine.assetNetIncome(asset)) + '/mes' : '—', 'g')}
      ${ui.stat('Cobro cada', fmtDuration(cyc.ms))}
      ${asset ? ui.stat('Valor hoy', money(engine.assetMarketValue(asset))) : ''}
      ${asset ? ui.stat('Revalorización', engine.appreciationPct(asset) + '%',
    engine.appreciationPct(asset) >= 0 ? 'g' : 'r') : ''}
    </div>
    ${asset ? `<div class="acts">
      <button class="btn danger" data-sell="${plot.uid}">Vender</button></div>` : ''}
  </div>`);

  onClick(ui.body, '[data-sell]', () => {
    if (asset) engine.sellAsset(asset.instanceId);
    city.remove(plot.uid);
    scene.syncViews();
    ui.close(); renderHud(); save();
  });
}

/**
 * Ficha de la naturaleza. Antes un toque sobre un arbol no hacia nada, asi
 * que no habia forma de recuperar el sitio que ocupaba.
 */
function showScenery(plot) {
  const body = ui.open('Naturaleza', `<div class="detail">
    <div class="hero">${ui.thumb(plot.sprite, 88)}
      <div><h3>Zona verde</h3>
      <p>Despejarla libera la casilla. Podras urbanizarla despues.</p></div></div>
    <div class="acts">
      <button class="btn ghost" data-clear="${plot.uid}">Despejar</button>
    </div></div>`);
  onClick(body, '[data-clear]', () => {
    city.remove(plot.uid);
    scene.syncViews();
    ui.close(); save();
    ui.toast('Zona despejada', 'good');
  });
}

/* ============================ ASESORES ============================= */
/*
 * Fiscalidad, deuda y seguros eran los tres paneles más densos del juego
 * viejo. Ahora son tres edificios de la ciudad: en vez de leer una tabla
 * de tramos del IRPF, vas al ayuntamiento.
 */

function showCivic(id) {
  const def = CIVIC.find(c => c.id === id);
  if (!def) return;
  bus.emit('advisor:open', { id });
  if (id === 'bank') return showBank(def);
  if (id === 'insurer') return showInsurance(def);
  return showTax(def);
}

function showTax(def) {
  const s = engine.taxStructures();
  const body = ui.open(def.icon + ' ' + def.name, `<div class="detail">
    <div class="stats">
      ${ui.stat('Renta pasiva', money(engine.totalPassiveIncome()) + '/mes', 'g')}
      ${ui.stat('Impuestos', money(engine.taxCost()) + '/mes', 'r')}
      ${ui.stat('Tipo efectivo', Math.round(engine.effectiveTaxRate()) + '%')}
      ${ui.stat('Estructura', (engine.taxStructure() || {}).label || 'Persona física')}
    </div>
    <div class="acts">${s.map(st => {
    const met = engine.taxRequirementsMet(st.id);
    const now = engine.taxVehicle === st.id;
    const cost = engine.taxCostFor(st.id);
    const tag = now ? ' · actual' : met ? '' : ' · bloqueada';
    // La leccion va debajo de cada opcion, no en un panel aparte: es el
    // motivo por el que existe la eleccion, y sin ella el jugador solo ve
    // cuatro botones con cifras que no sabe comparar.
    return `<button class="btn ghost" data-tax="${st.id}" ${now || !met ? 'disabled' : ''}>
        ${st.emoji} ${st.label} · pagarías ${money(cost)}/mes${tag}
        <br><small style="opacity:.65;font-weight:400">
        ${st.setup ? 'Constituirla cuesta ' + money(st.setup) + '. ' : ''}${st.lesson}</small>
      </button>`;
  }).join('')}</div>
  </div>`);
  onClick(body, '[data-tax]', (b) => {
    const r = engine.adoptTax(b.dataset.tax);
    ui.toast(r && r.ok === false ? (r.reason || 'No disponible') : 'Estructura adoptada',
      r && r.ok === false ? 'bad' : 'good');
    renderHud(); ui.close();
  });
}

function showBank(def) {
  const body = ui.open(def.icon + ' ' + def.name, `<div class="detail">
    <div class="stats">
      ${ui.stat('Deuda verde', money(engine.totalGreenDebtPayment()) + '/mes', 'g')}
      ${ui.stat('Deuda roja', money(engine.totalRedDebtBalance()), 'r')}
      ${ui.stat('Límite de crédito', money(engine.creditLimit()))}
      ${ui.stat('Colchón', engine.cashCushionMonths().toFixed(1) + ' meses')}
    </div>
    <div class="acts">
      <button class="btn ghost" data-loan="5000">Pedir 5.000 €</button>
      ${engine.redDebts.map(d => `<button class="btn danger" data-repay="${d.id}">
        Amortizar ${d.label || 'préstamo'} · ${money(d.balance)}</button>`).join('')}
    </div>
  </div>`);
  onClick(body, '[data-loan]', (b) => {
    engine.takeConsumerLoan(+b.dataset.loan);
    ach.bumpRun('red_loans_taken');
    ui.toast('Préstamo concedido. Ojo a la cuota.', 'bad');
    renderHud(); ui.close();
  });
  onClick(body, '[data-repay]', (b) => {
    engine.repayRedDebt(b.dataset.repay);
    renderHud(); ui.close();
  });
}

function showInsurance(def) {
  const body = ui.open(def.icon + ' ' + def.name, `<div class="detail">
    <div class="stats">
      ${ui.stat('Coste', money(engine.insuranceMonthlyCost()) + '/mes', 'r')}
      ${ui.stat('Cobertura', Math.round(engine.insuranceCoverage() * 100) + '%', 'g')}
    </div>
    <div class="acts">${engine.insurancePolicies().map(p => {
    const on = engine.hasInsurance(p.id);
    return `<button class="btn ${on ? '' : 'ghost'}" data-ins="${p.id}">
        ${on ? '✓ ' : ''}${p.emoji} ${p.label} · ${money(p.monthly)}/mes
        <br><small style="opacity:.65;font-weight:400">
        Cubre un ${Math.round(p.coverage * 100)}% del golpe. ${p.desc}</small>
      </button>`;
  }).join('')}
    </div>
  </div>`);
  onClick(body, '[data-ins]', (b) => { engine.toggleInsurance(b.dataset.ins); renderHud(); ui.close(); });
}

/* ============================== OBRAS ============================== */

function showBuilders() {
  const list = city.building();
  const body = ui.open('Obras', list.length ? `
    <div class="detail"><div class="acts">${list.map(p => `
      <button class="btn ghost" data-go="${p.uid}">
        ${p.sprite} · lista en ${fmtDuration(p.doneAt - Date.now())}</button>`).join('')}
    </div></div>` : `<div class="empty">
      No hay obras en marcha.<br>Tienes ${city.buildersFree()} de ${city.buildersTotal()} obreros libres.</div>`);
  onClick(body, '[data-go]', (b) => {
    const p = city.plots.get(+b.dataset.go);
    if (p) { scene.centerOnPlot(p); ui.close(); }
  });
}

function showFreedom() {
  bus.emit('ie:open');
  const ie = engine.emancipationIndex();
  ui.open('Camino a la libertad', `<div class="detail">
    <div class="stats">
      ${ui.stat('Indicador', Math.round(ie) + '%', ie >= engine.winTargetIE() ? 'g' : '')}
      ${ui.stat('Objetivo', Math.round(engine.winTargetIE()) + '%')}
      ${ui.stat('Rentas netas', money(engine.netPassiveIncome()) + '/mes', 'g')}
      ${ui.stat('Gastos fijos', money(engine.fixedExpenses()) + '/mes', 'r')}
      ${ui.stat('Cashflow', money(engine.netMonthlyCashflow(engine.effectiveSalaryBase())) + '/mes')}
      ${ui.stat('Colchón', engine.cashCushionMonths().toFixed(1) + ' meses')}
    </div>
    <p style="color:var(--dim);font-size:13px;margin:0">
      Eres libre cuando tus rentas cubren el ${Math.round(engine.winTargetIE())}%
      de lo que te cuesta vivir, con seis meses de colchón en caja.</p>
  </div>`);
}

function showMenu() {
  ui.open('Más', `<div class="detail"><div class="acts">
    <button class="btn" data-act="school">🎓 La Escuela${
  school.unread ? ` · ${school.unread} sin leer` : ''}</button>
    <button class="btn ghost" data-act="trophies">🏅 Logros</button>
    <button class="btn ghost" data-act="news">📰 Qué ha pasado en tu ciudad</button>
    <button class="btn ghost" data-act="collect">Cobrar todo</button>
    <button class="btn ghost" data-act="arrange">Ordenar la ciudad</button>
    <button class="btn ghost" data-act="scenery">Sembrar verde</button>
    <button class="btn danger" data-act="reset">Empezar otra ciudad</button>
  </div></div>`);
  onClick(ui.body, '[data-act]', (b) => {
    if (b.dataset.act === 'school') return showSchool();
    if (b.dataset.act === 'news') return panels.showNews();
    if (b.dataset.act === 'trophies') return showTrophies();
    if (b.dataset.act === 'collect') { ui.close(); collectAll(); }
    if (b.dataset.act === 'arrange') {
      const n = city.arrange();
      scene.syncViews();
      [...city.plots.keys()].forEach(uid => scene.refresh(uid));
      ui.close(); save();
      ui.toast(n ? `${n} edificios realineados` : 'Ya estaba ordenada', 'good');
    }
    if (b.dataset.act === 'scenery') { city.sprinkleScenery(6); scene.syncViews(); ui.close(); }
    if (b.dataset.act === 'reset') resetGame();
  });
}

/* =========================== PERSISTENCIA ========================== */

/*
 * Al reiniciar hay que dejar de guardar ANTES de recargar. Si no, el
 * `beforeunload` vuelve a escribir la partida que se acaba de borrar y el
 * boton de empezar otra ciudad no hace nada: sales de la pagina y al
 * volver te encuentras la misma ciudad.
 */
let stopSaving = false;

function resetGame() {
  stopSaving = true;
  localStorage.removeItem(SAVE_KEY);
  Guide.reset();
  location.reload();
}

function save() {
  if (!engine || stopSaving) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      v: 1, engine: engine.toJSON(), city: city.toJSON(), clock: clock.toJSON(),
      incidents: incidents.toJSON(),
    }));
  } catch (e) { /* cuota llena: no es motivo para tumbar la partida */ }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.engine && s.city ? s : null;
  } catch (e) { return null; }
}

main().catch(err => {
  console.error(err);
  document.querySelector('.ob-steps').innerHTML =
    `<div class="empty">No se ha podido cargar el juego.<br><small>${err.message}</small></div>`;
});
