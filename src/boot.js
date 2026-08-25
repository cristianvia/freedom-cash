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

const SAVE_KEY = 'freedomcash.city.v1';
const $ = (s) => document.querySelector(s);

const DATA = {};
let engine, city, clock, scene, game, ui, models;

/* ============================== CARGA ============================== */

const loadJSON = (p) => fetch(p, { cache: 'no-cache' }).then(r => r.json());

async function loadAll() {
  const files = ['assets_database', 'profiles', 'events', 'difficulty',
    'professions', 'tax', 'insurance', 'contracts', 'models'];
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
  city = new City(engine, DATA.models, DATA.atlas);
  city.sprinkleScenery(10);
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
  city = new City(engine, DATA.models, DATA.atlas);
  city.load(save.city);
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
    onTapEmpty: () => ui.close(),
    onReady: (s) => { scene = s; window.FC.scene = s; sceneReady(resumed); },
  });

  // Enganche de depuración: permite inspeccionar y forzar estados desde la
  // consola sin tener que jugar media hora para llegar a la situación.
  window.FC = { engine, city, clock, scene: null, ui, game, DATA };
}

function sceneReady(resumed) {
  // Los meses pendientes se recuperan al entrar: en un builder, media
  // partida transcurre con el juego cerrado.
  const missed = clock.catchUp();
  if (resumed && missed.length) reportOffline(missed);

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

/** Un mes del motor. No lo dispara el jugador: lo dispara el reloj. */
function runPeriod() {
  const snap = engine.endTurn();
  engine.actionsUsed = 0;         // aquí el freno son los constructores
  return snap;
}

function tick() {
  clock.catchUp();
  const done = city.tickBuilds();
  done.forEach(p => {
    scene.refresh(p.uid);
    scene.popBuilt(p);
    city.addXp(4 * p.tier);
  });
  if (done.length) ui.toast(done.length === 1 ? 'Obra terminada' : `${done.length} obras terminadas`, 'good');
  renderHud();
}

function reportOffline(snaps) {
  const got = city.list().reduce((s, p) => s + city.pending(p).cash, 0);
  ui.toast(`Han pasado ${snaps.length} ${snaps.length === 1 ? 'mes' : 'meses'}` +
    (got > 0 ? ` · ${money(got)} esperándote` : ''), 'good');
}

/* =============================== HUD =============================== */

function renderHud() {
  const s = engine.status ? engine.status() : {};
  $('#res-cash b').textContent = short(engine.cash);
  $('#res-mat b').textContent = city.materials;
  $('#res-mat .cap').textContent = '/' + city.materialCap();
  $('#res-mat').classList.toggle('full', city.materialsFull());
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
}

function collectAll() {
  const got = city.collectAll();
  if (!got.count) return ui.toast('Nada que cobrar todavía');
  if (got.cash) ui.toast(`+${money(got.cash)}`, 'good');
  else if (got.materials) ui.toast(`+${got.materials} 🧱`, 'good');
  renderHud();
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
  const plants = MATERIAL_PLANTS.filter(p => p.minLevel <= city.level);
  const body = ui.open('Construir', `
    <div class="cards" id="shop-plants">${plants.map(plantCard).join('')}</div>
    <div style="height:14px"></div>
    <div class="cards" id="shop-assets">${catalogFor().map(assetCard).join('')}</div>`);

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
    save();
  });
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
    city.add({ kind: 'plant', plantId: p.id, sprite: p.sprite,
      category: 'digital_business', buildMs: p.buildMs }, col, row);
    scene.syncViews();
    renderHud();
    save();
  });
}

/* ============================== FICHA ============================== */

function showPlot(plot) {
  if (plot.kind === 'civic') return showCivic(plot.civicId);
  if (plot.kind === 'scenery') return;

  const got = city.pending(plot);
  // Un toque sobre algo que ya tiene dinero dentro lo cobra directamente:
  // obligar a abrir una ficha para recoger sería un paso de más en el
  // gesto más repetido del juego.
  if (got.ready && plot.state === 'ready') {
    const g = city.collect(plot);
    if (g.cash) scene.popCollect(plot, '+' + money(g.cash));
    if (g.materials) scene.popCollect(plot, '+' + g.materials + ' 🧱', 'mat');
    renderHud();
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

/* ============================ ASESORES ============================= */
/*
 * Fiscalidad, deuda y seguros eran los tres paneles más densos del juego
 * viejo. Ahora son tres edificios de la ciudad: en vez de leer una tabla
 * de tramos del IRPF, vas al ayuntamiento.
 */

function showCivic(id) {
  const def = CIVIC.find(c => c.id === id);
  if (!def) return;
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
    <button class="btn ghost" data-act="collect">Cobrar todo</button>
    <button class="btn ghost" data-act="scenery">Sembrar verde</button>
    <button class="btn danger" data-act="reset">Empezar otra ciudad</button>
  </div></div>`);
  onClick(ui.body, '[data-act]', (b) => {
    if (b.dataset.act === 'collect') { ui.close(); collectAll(); }
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
  location.reload();
}

function save() {
  if (!engine || stopSaving) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      v: 1, engine: engine.toJSON(), city: city.toJSON(), clock: clock.toJSON(),
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
