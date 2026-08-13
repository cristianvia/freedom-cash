/**
 * main.js — Controlador principal de Freedom Cash.
 * Une EconomyEngine (lógica) + IsoCity (render) + DOM (UI fintech).
 */
import { EconomyEngine, ERA_ASSET_STEP, ERA_START_RATIO } from './engine/EconomyEngine.js';
import { IsoCity } from './engine/IsoCity.js';
import { takeBotTurn } from './engine/BotAI.js';
import { Tutorial } from './ui/tutorial.js';
import { computeScore, submitScore, topScores } from './engine/Leaderboard.js';
import { Achievements } from './engine/Achievements.js';
import { Sfx } from './engine/Sfx.js';

const $ = (id) => document.getElementById(id);
const euro = (n) => `${Math.round(n).toLocaleString('es-ES')} €`;
// chip con emoji (siempre visible) + texto (ocultable en móvil)
const chipHTML = (emoji, text) => `<span class="chip-ic">${emoji}</span><span class="chip-txt"> ${text}</span>`;
const shuffleArr = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rand = (a, b) => a + Math.random() * (b - a);
const SAVE_KEY = 'freedomcash.save.v1';
const TUT_KEY = 'freedomcash.tutorialDone.v1';

/* Pasos del walk-through guiado (spotlight sobre cada panel). */
const TUTORIAL_STEPS = [
  { title: '👋 Bienvenido a Freedom Cash',
    text: 'Tu meta: que tus rentas pasivas cubran el <b>120% de tus gastos</b> (el Indicador de Emancipación) con 6 meses de colchón en caja… y llegar antes que tus rivales. Te enseño en 30 segundos.' },
  { sel: '.panel.freedom', title: 'Indicador de Emancipación (IE)',
    text: 'Este es tu marcador principal y su evolución en el tiempo. Cuando la barra llegue al 120%, la libertad financiera está a un paso.' },
  { sel: '#panel-cash', title: 'Tu tesorería',
    text: 'Tu caja disponible y el cashflow neto de cada mes. El <b>colchón</b> mide cuántos meses aguantarías sin ingresos: necesitas 6 para ganar.' },
  { sel: '#panel-wellbeing', title: 'No todo es dinero: tu bienestar',
    text: 'Tu <b>😊 Felicidad</b> y <b>⚡ Energía</b> bajan con el tiempo. Si la felicidad llega a 0, <b>abandonas</b>; sin energía sufres <b>burnout</b> y tu sueldo cae. Gasta en vivir (abajo, Estilo de vida) para recargarte.' },
  { sel: '#panel-lifestyle', title: 'Estilo de vida',
    text: 'Cenas, viajes, deporte o formación: cuestan dinero pero recargan tu bienestar (y la formación sube tu sueldo). Equilibrar dinero y vida es la clave del juego.' },
  { sel: '#panel-market', title: 'Marketplace de activos',
    text: 'Aquí compras activos que generan renta. <b>Al contado</b> pagas el precio completo; con <b>Hipoteca</b> solo pagas la entrada y asumes una cuota mensual (apalancamiento).' },
  { sel: '#city', title: 'Tu ciudad crece contigo',
    text: 'Cada activo que compras aparece construido aquí, organizado por distritos: 🏠 inmuebles, 💻 negocios y 📈 financiero.' },
  { sel: '#panel-debt', title: 'Deuda verde vs roja',
    text: 'La <b style="color:#2ee6a0">deuda verde</b> (hipotecas de activos) se autopaga: es buena. La <b style="color:#ff5d6c">deuda roja</b> (préstamos de consumo) resta liquidez y penaliza tu IE.' },
  { sel: '#panel-tax', title: 'Estrategia: fiscalidad',
    text: 'Los impuestos son media partida. Hay una <b>escalera</b> de estructuras legales — persona física → sociedad → holding → SOCIMI — y tu asesor te dice cuándo compensa subir… y cuándo subir te haría perder dinero. Los inmuebles además <b>amortizan</b>: deducen sin que salga dinero de tu bolsillo.' },
  { sel: '#panel-rank', title: 'La carrera por la libertad',
    text: 'No juegas solo: compites contra bots rivales. Quien alcance la libertad financiera <b>primero</b>, gana la partida.' },
  { sel: '#btn-endturn', title: 'Pasa de mes y cobra',
    text: 'Cuando termines tus jugadas del mes, pulsa aquí para cobrar, avanzar el calendario y afrontar un evento económico aleatorio. ¡Mucha suerte! 🚀' },
];

function startTutorial(startIndex = 0) {
  const t = new Tutorial(TUTORIAL_STEPS, () => { try { localStorage.setItem(TUT_KEY, '1'); } catch (e) {} });
  if (typeof startIndex === 'number' && startIndex > 0) { t.i = Math.min(startIndex, TUTORIAL_STEPS.length - 1); t.render(); }
  return t;
}
function maybeTutorial() {
  if (new URLSearchParams(location.search).get('auto')) return; // no en demos
  let done = false;
  try { done = localStorage.getItem(TUT_KEY) === '1'; } catch (e) {}
  if (!done) startTutorial();
}

let engine = null;
let city = null;
let bots = [];              // oponentes IA: { name, emoji, engine, aggr }
let DATA = { assets: [], profiles: [], events: [] };
let catalog = [];           // catálogo vigente (DATA.assets escalado a la era actual)
let market = [];            // oportunidades visibles este turno
let p2pOffers = [];         // activos que los rivales ponen a la venta
let p2pSeq = 0;             // contador de instancias compradas por P2P
let ended = false;          // evita disparar el fin de partida dos veces
let rivalWinsSeen = [];     // rivales cuya victoria ya te avisamos (si decides seguir)
let activityLog = [];       // feed de actividad (jugador + rivales)
let ach = null;             // logros + meta-progresión (persiste entre partidas)
const sfx = new Sfx();      // sonido sintetizado + háptica
let AUTO_MODE = false;      // demos/test: resuelve dilemas automáticamente
let fastMode = false;       // avance rápido: encadena meses sin narrarlos uno a uno
let awaitingChoice = false; // hay un dilema en pantalla esperando respuesta
let globalView = false;     // alterna entre "mi ciudad" y "vista global"
const spriteMap = {};       // key -> url para IsoCity

/* ----------------------------- CARGA ------------------------------ */
// Los datos DEBEN cuadrar con el código: si el navegador sirve un JSON viejo de
// caché tras un deploy, el juego arranca con un catálogo que no corresponde.
// 'no-cache' revalida siempre (no refetchea si no ha cambiado: es barato).
const loadJSON = (file) =>
  fetch(`src/data/${file}`, { cache: 'no-cache' }).then(r => r.json());

async function loadData() {
  const [a, p, e, l, v, d, g, pr, ac, tx, ins, ct] = await Promise.all([
    loadJSON('assets_database.json'),
    loadJSON('profiles.json'),
    loadJSON('events.json'),
    loadJSON('lifestyle.json'),
    loadJSON('vehicles.json'),
    loadJSON('difficulty.json'),
    loadJSON('gigs.json'),
    loadJSON('professions.json'),
    loadJSON('achievements.json'),
    loadJSON('tax.json'),
    loadJSON('insurance.json'),
    loadJSON('contracts.json'),
  ]);
  ach = new Achievements(ac);
  DATA.assets = a.assets;
  DATA.profiles = p.profiles;
  DATA.events = e.events;
  DATA.lifestyle = l.actions;
  DATA.vehicles = v.vehicles;
  DATA.modes = d.modes;
  DATA.gigs = g.gigs;
  DATA.professions = pr.professions;
  DATA.tax = tx;
  DATA.insurance = ins;
  DATA.contracts = ct;

  // todos los sprites (suelo, decoración, edificios y coches) por su clave
  const TILE_KEYS = ['t_ground', 't_grass', 't_plaza', 't_tree', 't_water', 't_road'];
  const BUILDING_KEYS = [
    // originales (los usan las tarjetas del marketplace por su sprite explícito)
    'b_home', 'b_apartment', 'b_vacation', 'b_house', 'b_shop', 'b_cafe',
    'b_office', 'b_coworking', 'b_bank', 'b_tower', 'b_startup', 'b_retail2',
    // variantes recoloreadas por distrito (variedad visual en la ciudad)
    ...Object.values(BUILDING_POOLS).flat(),
  ];
  [...TILE_KEYS, ...BUILDING_KEYS].forEach(k => { spriteMap[k] = `assets/sprites/${k}.png`; });
}

// Pools de sprites por distrito: dan variedad de color Y forma a la ciudad
const BUILDING_POOLS = {
  real_estate: ['re_brick_tall', 're_brick_twotier', 're_sand_block', 're_sand_office',
    're_olive_arched', 're_olive_house', 're_rose_shop', 're_rose_wide'],
  digital_business: ['biz_blue_tall', 'biz_blue_twotier', 'biz_teal_block', 'biz_teal_office',
    'biz_indigo_arched', 'biz_indigo_house', 'biz_slate_shop', 'biz_slate_wide'],
  financial: ['fin_gold_tall', 'fin_gold_twotier', 'fin_purple_block', 'fin_purple_office',
    'fin_emerald_arched', 'fin_emerald_house', 'fin_bronze_shop', 'fin_bronze_wide'],
};

/* ------------------------- SELECCIÓN PERFIL ----------------------- */
function renderProfiles() {
  const wrap = $('profiles');
  wrap.innerHTML = '';
  DATA.profiles.forEach(p => {
    const el = document.createElement('div');
    el.className = 'profile';
    const salaryTxt = p.salary_variance
      ? `${euro(p.salary_base - p.salary_variance)}–${euro(p.salary_base + p.salary_variance)}`
      : euro(p.salary_base);
    el.innerHTML = `
      <div class="emoji">${p.emoji}</div>
      <h3>${p.name}</h3>
      <div class="pd">${p.description}</div>
      <div class="stats2">
        <div><span>Sueldo/mes</span><b>${salaryTxt}</b></div>
        <div><span>Gastos/mes</span><b>${euro(p.fixed_expenses)}</b></div>
        <div><span>Caja inicial</span><b>${euro(p.starting_cash)}</b></div>
      </div>
      <div class="rating">Rating ${p.credit_rating}</div>`;
    el.onclick = () => chooseProfession(p);
    wrap.appendChild(el);
  });
}

/* ------------------------ SELECCIÓN PROFESIÓN -------------------- */
function chooseProfession(profile) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal">
      <h2>Elige tu profesión</h2>
      <p class="lead">2/3 · Con ${profile.emoji} <b>${profile.name}</b>. Tu profesión desbloquea
        <b>proyectos de tu campo</b> en el Marketplace, además de las oportunidades para todos.</p>
      <div class="prof-grid">
        ${DATA.professions.map(pr => `
          <button class="prof-opt" data-prof="${pr.id}">
            <span class="prof-em">${pr.emoji}</span>
            <b>${pr.label}</b>
            <span class="prof-desc">${pr.desc}</span>
            ${pr.projects ? `<span class="prof-proj">🔓 ${pr.projects.join(' · ')}</span>` : ''}
          </button>`).join('')}
      </div>
      <button class="btn-ghost" id="prof-back" style="width:100%;margin-top:14px">‹ Volver a perfiles</button>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#prof-back').onclick = () => ov.remove();
  ov.querySelectorAll('button[data-prof]').forEach(btn => {
    btn.onclick = () => {
      const profession = DATA.professions.find(pr => pr.id === btn.dataset.prof);
      ov.remove();
      chooseDifficulty(profile, profession);
    };
  });
}

/* ------------------------ SELECCIÓN DIFICULTAD -------------------- */
function chooseDifficulty(profile, profession) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.id = 'diff-overlay';
  ov.innerHTML = `
    <div class="modal">
      <h2>Elige la dificultad</h2>
      <p class="lead">3/3 · Con ${profile.emoji} <b>${profile.name}</b> · ${profession.emoji} <b>${profession.label}</b>.
        La dificultad cambia tu punto de partida y cuánto puntúas en la liga.</p>
      <div class="diff-list">
        ${DATA.modes.map(m => `
          <button class="diff-opt" data-mode="${m.id}">
            <div class="diff-top"><span class="diff-em">${m.emoji}</span>
              <b>${m.label}</b><span class="diff-mult">×${m.scoreMult} pts</span></div>
            <div class="diff-desc">${m.desc}</div>
            <div class="diff-nums">
              Caja inicial ${euro(Math.round(profile.starting_cash * m.cashMult))} ·
              Sueldo ${Math.round(m.salaryMult * 100)}%${m.extraRent ? ` · Alquiler ${euro(m.extraRent)}/mes` : ''}${m.gigs ? ' · 💼 Trabajos extra' : ''}
            </div>
          </button>`).join('')}
      </div>
      <button class="btn-ghost" id="diff-back" style="width:100%;margin-top:12px">‹ Volver a profesiones</button>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#diff-back').onclick = () => { ov.remove(); chooseProfession(profile); };
  ov.querySelectorAll('button[data-mode]').forEach(btn => {
    btn.onclick = () => {
      const mode = DATA.modes.find(m => m.id === btn.dataset.mode);
      ov.remove();
      startGame(profile, mode, profession);
    };
  });
}

/* ---------------------------- ARRANQUE ---------------------------- */
async function startGame(profile, mode = null, profession = null) {
  mode = mode || DATA.modes[0];
  profession = profession || DATA.professions[0];
  engine = new EconomyEngine(profile, DATA.events, mode);
  engine.setTaxData(DATA.tax);
  engine.setInsuranceData(DATA.insurance);
  engine.setContractData(DATA.contracts);
  engine.professionId = profession.id;
  buildCatalog();
  ended = false;
  ach.newRun();
  ach.bumpLife('games');
  $('profile-overlay').style.display = 'none';
  $('hud-profile').innerHTML = chipHTML(profile.emoji, profile.short || profile.name);
  $('hud-prof').innerHTML = chipHTML(profession.emoji, profession.label);
  $('hud-prof').style.display = profession.id === 'none' ? 'none' : '';
  $('hud-mode').innerHTML = chipHTML(mode.emoji, mode.label);
  $('hud-mode').style.display = '';

  // oponentes IA: los otros perfiles disponibles (mismo modo, profesión aleatoria)
  const others = DATA.profiles.filter(p => p.id !== profile.id);
  const profPool = DATA.professions.filter(pr => pr.id !== 'none');
  const rivalNames = shuffleArr(['Ana', 'Marcos', 'Lucía', 'Diego', 'Sara', 'Javi', 'Nora', 'Pablo']);
  bots = others.map((bp, i) => {
    const be = new EconomyEngine(bp, DATA.events, mode);
    be.setTaxData(DATA.tax);
    be.setInsuranceData(DATA.insurance);
    be.professionId = profPool.length ? profPool[Math.floor(Math.random() * profPool.length)].id : 'none';
    return { name: rivalNames[i] || 'Rival', emoji: bp.emoji, engine: be, aggr: 0.5 + i * 0.15 };
  });
  rivalWinsSeen = [];

  // ciudad con distritos
  const canvas = $('city');
  city = new IsoCity(canvas, 6, 6);
  await city.loadSprites(spriteMap);
  city.setBuildingPools(BUILDING_POOLS);
  window.addEventListener('resize', () => city.resize());
  city.resize();
  city.buildDistricts();

  refreshMarket();
  render();
  maybeTutorial();
}

/* ---------------------- CATÁLOGO POR ERA -------------------------- */
/**
 * En el Modo Legado el listón sube, así que el mercado también: cada era
 * ofrece una versión mayor de cada activo (más precio, pero mejor yield).
 * Los activos ya comprados no cambian — se guardan enteros en la partida.
 */
const ERA_TIER = ['', 'Plus', 'Prime', 'Élite', 'Legendario', 'Mítico', 'Ancestral', 'Absoluto'];

/** Sello de calibre del activo para una era. Sin techo: 'Absoluto ×3'. */
function eraTier(era) {
  const i = Math.min(era, ERA_TIER.length) - 1;
  const extra = era > ERA_TIER.length ? ` ×${era - ERA_TIER.length + 1}` : '';
  return ERA_TIER[i] + extra;
}

function eraCatalog(assets, era, inflation = 1) {
  if (era <= 1 && inflation < 1.02) return assets;
  // el mercado inflaciona con el mundo: si tu coste de vida sube y los precios
  // no, una era larga se vuelve imposible por pura aritmética
  const k = Math.pow(ERA_ASSET_STEP, era - 1) * inflation;   // escala de precio
  const y = k * (1 + 0.06 * (era - 1));          // escala de renta (yield algo mejor)
  const tier = eraTier(era);
  const sc = (v, m) => Math.round((v || 0) * m);
  return assets.map(a => {
    const f = a.financials;
    return {
      ...a,
      // el id SOLO depende de la era: si cambiase con la inflación, las
      // referencias guardadas (tablón, partida salvada) dejarían de resolver
      id: era > 1 ? `${a.id}@e${era}` : a.id,
      baseId: a.baseId || a.id,
      title: era > 1 ? `${a.title} · ${tier}` : a.title,
      era,
      financials: {
        total_price: sc(f.total_price, k),
        down_payment_required: sc(f.down_payment_required, k),
        mortgage_available: sc(f.mortgage_available, k),
        monthly_mortgage_cost: sc(f.monthly_mortgage_cost, k),
        gross_monthly_income: sc(f.gross_monthly_income, y),
        maintenance_and_taxes: sc(f.maintenance_and_taxes, k),
        net_monthly_cashflow: sc(f.gross_monthly_income, y) - sc(f.maintenance_and_taxes, k),
      },
      metrics: {
        ...a.metrics,
        // más tamaño, más exposición: el riesgo de vacancia/volatilidad sube
        vacancy_rate_risk: Math.min(0.6, (a.metrics.vacancy_rate_risk || 0) * (1 + 0.12 * (era - 1))),
      },
    };
  });
}

/** Recalcula el catálogo vigente a partir de la era y la inflación del motor. */
function buildCatalog() {
  catalog = eraCatalog(DATA.assets, engine ? engine.era : 1, engine ? engine.expenseInflation : 1);
  // el tablón apunta a los objetos del catálogo: hay que reengancharlo tras rehacerlo
  market.forEach(m => {
    const fresh = catalog.find(a => a.id === m.asset.id);
    if (fresh) m.asset = fresh;
  });
}

/* -------------------------- MARKETPLACE --------------------------- */
/*
 * El mercado ya no se rebaraja entero cada mes: las oportunidades PERMANECEN
 * unos meses en el tablón. Eso hace viable ahorrar para una concreta… pero los
 * rivales miran las mismas ofertas, así que esperar tiene un precio.
 */
const MARKET_SLOTS = 4;
const MARKET_TTL = [3, 6];   // meses que aguanta una oportunidad en el tablón

/**
 * ¿Puedo pagarlo ahora mismo? (ignora el límite de acciones: es asequibilidad)
 * Mira el precio de HOY, movido por el ciclo, que es el que enseña la tarjeta y
 * el que aplica el botón de comprar: si no, en recesión el tablón se creía
 * bloqueado con activos que sí podías pagar.
 */
function affordable(a) {
  const f = engine.pricedFinancials(a);
  const cash = engine.cash >= f.total_price;
  const lev = a.leverage_allowed &&
    f.mortgage_available <= engine.creditLimit() &&
    engine.cash >= f.down_payment_required;
  return cash || lev;
}

/** Rivales que pueden permitirse esta oportunidad: son quienes te la pueden quitar. */
function rivalsEyeing(asset) {
  return bots.filter(b => {
    if (!b.engine.assetEligible(asset) || b.engine.hasLost()) return false;
    const f = asset.financials;
    return b.engine.cash >= f.total_price ||
      (asset.leverage_allowed && f.mortgage_available <= b.engine.creditLimit() &&
       b.engine.cash >= f.down_payment_required);
  });
}

/**
 * El "hueco de entrada": de todo lo que puedes pagar HOY, algo de la mitad alta
 * de tu alcance. Sustituye al viejo rescate, que elegía por precio absoluto y
 * por tanto te plantaba siempre el mismo activo mínimo del catálogo —el
 * trastero— en cuanto ibas justo de caja. Como esto se mide contra tu bolsillo
 * y no contra el catálogo, la puerta de entrada sube contigo.
 */
function entryPick(exclude = new Set()) {
  const pool = catalog
    .filter(a => engine.assetEligible(a) && !exclude.has(a.id) && affordable(a))
    .sort((a, b) => a.financials.total_price - b.financials.total_price);
  if (!pool.length) return null;
  const from = Math.floor(pool.length / 2);
  return pool[from + Math.floor(Math.random() * (pool.length - from))];
}

/** Lo que cuesta entrar en un activo: la entrada si se puede hipotecar. */
function entryCost(a) {
  const f = engine.pricedFinancials(a);
  return a.leverage_allowed && f.mortgage_available <= engine.creditLimit()
    ? f.down_payment_required : f.total_price;
}

/**
 * Peso de una oportunidad en el sorteo del tablón. Es una campana en escala
 * logarítmica centrada en lo que hoy puedes mover: con tres millones en caja
 * ya no te ofrece el trastero de 9.000 €, y con veinte mil no te llena el
 * tablón de naves industriales. La cola derecha deja pasar alguna que aún no
 * puedes pagar — la zanahoria por la que merece la pena ahorrar.
 * Y lo que ya tienes por triplicado sale la mitad de veces: repetir aburre.
 */
function bandWeight(a) {
  const ref = Math.max(2500, engine.cash * 0.55);
  const d = Math.log(Math.max(1, entryCost(a)) / ref);
  const band = Math.exp(-(d * d) / 1.7);
  const mine = engine.ownedAssets.filter(x => engine.baseIdOf(x) === (a.baseId || a.id)).length;
  return band * (mine >= 3 ? 0.5 : 1);
}

/** Sorteo ponderado por la franja. */
function pickWeighted(pool) {
  const total = pool.reduce((s, a) => s + bandWeight(a), 0);
  if (total <= 0) return pool[Math.floor(Math.random() * pool.length)];
  let r = Math.random() * total;
  for (const a of pool) { r -= bandWeight(a); if (r <= 0) return a; }
  return pool[pool.length - 1];
}

/** Rellena los huecos del tablón con oportunidades nuevas. */
function fillMarket() {
  const inMarket = new Set(market.map(m => m.asset.id));
  let pool = catalog.filter(a => engine.assetEligible(a) && !inMarket.has(a.id));
  // sesga hacia proyectos de tu profesión si no hay ninguno en el tablón
  const myProjects = pool.filter(a => a.profession === engine.professionId);
  while (market.length < MARKET_SLOTS && pool.length) {
    const wantsProject = engine.professionId !== 'none' && myProjects.length &&
      !market.some(m => m.asset.profession) && Math.random() < 0.6;
    const src = wantsProject ? myProjects : pool;
    const pick = pickWeighted(src);
    pool = pool.filter(a => a.id !== pick.id);
    const i = myProjects.indexOf(pick); if (i >= 0) myProjects.splice(i, 1);
    market.push({ asset: pick, left: Math.round(rand(MARKET_TTL[0], MARKET_TTL[1])) });
  }
  // un hueco es siempre algo que puedes pagar hoy: el tablón nunca se atasca
  if (market.length && !market.some(m => affordable(m.asset))) {
    const pick = entryPick(new Set(market.map(m => m.asset.id)));
    if (pick) {
      market[market.length - 1] = { asset: pick, left: Math.round(rand(MARKET_TTL[0], MARKET_TTL[1])) };
    }
  }
}

/** Arranque de partida: tablón limpio. */
function refreshMarket() {
  market = [];
  fillMarket();
  renderMarket();
}

/**
 * Fin de mes: las oportunidades envejecen y algunas caducan. Lo que no compras
 * no te espera indefinidamente.
 */
function tickMarket() {
  const expired = [];
  market = market.filter(m => {
    m.left -= 1;
    if (m.left > 0) return true;
    expired.push(m.asset);
    return false;
  });
  expired.forEach(a => logActivity(`⌛ Se retiró del mercado: ${a.title}`, 'neutral'));
  fillMarket();
}

/**
 * Los rivales compran del mismo tablón que tú. Si dejaste pasar una buena
 * oportunidad que ellos pueden pagar, se la llevan — y te enteras por el feed.
 */
function botsSnipeMarket() {
  const sniped = [];
  market.slice().forEach(m => {
    const rivals = rivalsEyeing(m.asset).filter(b => b.engine.canAct().ok);
    if (!rivals.length) return;
    // cuanto más apetecible y más rivales, más probable que vuele
    const heat = Math.min(0.45, 0.12 * rivals.length + (m.left <= 2 ? 0.1 : 0));
    if (Math.random() > heat) return;
    const b = rivals[Math.floor(Math.random() * rivals.length)];
    const fin = (m.asset.leverage_allowed && b.engine.canBuy(m.asset, 'leverage').ok)
      ? 'leverage' : (b.engine.canBuy(m.asset, 'cash').ok ? 'cash' : null);
    if (!fin || !b.engine.buyAsset(m.asset, fin).ok) return;
    market = market.filter(x => x !== m);
    sniped.push({ b, a: m.asset });
  });
  sniped.forEach(({ b, a }) =>
    logActivity(`⚡ ${b.emoji} ${b.name} se llevó ${a.title} del mercado`, 'bad'));
  return sniped;
}

function renderMarket() {
  const wrap = $('market');
  wrap.innerHTML = '';
  market.forEach(m => {
    const base = m.asset;
    // la tarjeta enseña el precio de HOY, movido por la fase del ciclo
    const a = { ...base, financials: engine.pricedFinancials(base) };
    const f = a.financials;
    const cycleDelta = Math.round((engine.cyclePriceMult() - 1) * 100);
    const cashCheck = engine.canBuy(a, 'cash');
    const levCheck = engine.canBuy(a, 'leverage');
    const catLabel = { real_estate: 'Inmueble', digital_business: 'Negocio', financial: 'Financiero' }[a.category];
    const prof = a.profession ? DATA.professions.find(pr => pr.id === a.profession) : null;
    const rivals = rivalsEyeing(a);
    // dos avisos honestos: cuánto le queda en el tablón y quién más la mira
    const ttlCls = m.left <= 2 ? 'hot' : '';
    const ttlTag = `<span class="ttl ${ttlCls}">⌛ ${m.left} ${m.left === 1 ? 'mes' : 'meses'}</span>`;
    const heatTag = rivals.length
      ? `<span class="heat" title="Pueden permitírsela y podrían adelantarse">🔥 ${rivals
          .slice(0, 2).map(b => b.name).join(', ')}${rivals.length > 2 ? ` +${rivals.length - 2}` : ''}</span>`
      : '';

    // Due diligence: las señales de alarma están a la vista; el análisis pagado
    // destapa lo que hay detrás. Nunca compras a ciegas sin haber podido mirar.
    const flags = engine.assetFlags(a);
    const known = engine.isInvestigated(a);
    const ddCost = engine.dueDiligenceCost(a);
    const ddCheck = engine.canInvestigate(a);
    const ddTag = known
      ? `<span class="dd done">🔎 Analizado</span>`
      : flags.length
        ? `<span class="dd warn">⚠️ ${flags.length} ${flags.length === 1 ? 'señal' : 'señales'}</span>`
        : '';
    const qual = known ? (a.quality || 'solid') : null;
    const flagsBox = (flags.length || known) ? `
      <div class="dd-box ${qual || ''}">
        ${known ? `<div class="dd-verdict ${qual}">${
            qual === 'scam' ? '🚨 CHIRINGUITO: es una estafa'
          : qual === 'speculative' ? '🎲 Apuesta real: puede multiplicarse o irse a cero'
          : '✅ Inversión sólida: sin riesgo de ruina'}</div>` : ''}
        ${known && a.warning ? `<div class="dd-warn">${a.warning}</div>` : ''}
        ${known && a.outcome ? `<div class="dd-odds">${
            a.outcome.ruin ? `<span class="bad">Ruina ${Math.round(a.outcome.ruin * 100)}%/mes</span>` : ''}${
            a.outcome.boom ? `<span class="good">Despegue ${Math.round(a.outcome.boom * 100)}%/mes</span>` : ''}</div>` : ''}
        ${flags.length ? `<ul class="dd-flags">${flags.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
        ${known ? '' : `<button class="btn-ghost btn-sm dd-btn" data-dd="${a.id}" ${ddCheck.ok ? '' : 'disabled'}
            title="${ddCheck.ok ? 'Encarga un análisis independiente' : ddCheck.reason}">
            🔎 Analizar · ${euro(ddCost)}</button>`}
      </div>` : '';
    // horquilla: el cashflow con hipoteca es peor que al contado, así que se
    // muestra la banda del modo que el jugador puede permitirse ahora mismo
    const bandCash = engine.incomeBand({ ...a, financing: 'cash' });
    const bandLev = a.leverage_allowed ? engine.incomeBand({ ...a, financing: 'leverage' }) : null;
    const band = (bandLev && !cashCheck.ok && levCheck.ok) ? bandLev : bandCash;
    const el = document.createElement('div');
    el.className = 'market-card' + (prof ? ' prof-card' : '');
    el.innerHTML = `
      ${prof ? `<div class="prof-badge">${prof.emoji} Proyecto de ${prof.label}</div>` : ''}
      <div class="top">
        <img src="${a.sprite}" alt="">
        <div>
          <div class="title">${a.title}</div>
          <span class="tag ${a.category}">${catLabel}</span>
        </div>
      </div>
      <div class="card-flags">${ttlTag}${heatTag}${ddTag}</div>
      ${flagsBox}
      <div class="desc">${a.description}</div>
      <div class="mini-grid">
        <span>Precio<b>${euro(f.total_price)}${cycleDelta ? `
          <em class="cyc-delta ${cycleDelta < 0 ? 'down' : 'up'}"
              title="${cycleDelta < 0 ? 'Rebajado' : 'Encarecido'} por la fase del ciclo (${engine.cyclePhase().label})"
              >${cycleDelta > 0 ? '+' : ''}${cycleDelta}%</em>` : ''}</b></span>
        <span>Entrada<b>${a.leverage_allowed ? euro(f.down_payment_required) : '—'}</b></span>
        <span>CoC medio<b>${a.metrics.coc_return_percentage}%</b></span>
        <span>Volatilidad<b>±${Math.round(band.spread * 100)}%</b></span>
      </div>
      <div class="band" title="Ningún activo renta lo mismo todos los meses: este es el rango realista de cashflow, y la media a largo plazo es ${euro(band.expected)}.">
        <span class="band-lbl">Cashflow / mes${band === bandLev ? ' (con hipoteca)' : ''}</span>
        <span class="band-range">
          <b class="${band.min >= 0 ? '' : 'red'}">${band.min >= 0 ? '+' : '−'}${euro(Math.abs(band.min))}</b>
          <i>a</i>
          <b class="green">+${euro(band.max)}</b>
        </span>
        <span class="band-avg">media ${euro(band.expected)}/mes</span>
      </div>
      <span style="font-size:11px;color:var(--txt-dim)">Riesgo de vacancia/volatilidad</span>
      <div class="risk"><i style="width:${Math.round(a.metrics.vacancy_rate_risk*100)}%"></i></div>
      <div class="buy-row">
        <button class="btn-cash" ${cashCheck.ok ? '' : 'disabled'} data-buy="cash" data-id="${a.id}"
          title="${cashCheck.ok ? 'Pagar al contado' : (cashCheck.reason || 'No disponible')}">
          Contado</button>
        ${a.leverage_allowed ? `
        <button class="btn-lever" ${levCheck.ok ? '' : 'disabled'} data-buy="leverage" data-rate="variable" data-id="${a.id}"
          title="${levCheck.ok
            ? `Cuota variable: ${euro(f.monthly_mortgage_cost * engine.VARIABLE_DISCOUNT * engine.mortgageModifier)}/mes hoy, sigue al mercado. Más barata ahora, expuesta a las subidas.`
            : (levCheck.reason || 'No disponible')}">
          Variable</button>
        <button class="btn-lever alt" ${levCheck.ok ? '' : 'disabled'} data-buy="leverage" data-rate="fixed" data-id="${a.id}"
          title="${levCheck.ok
            ? `Cuota fija: ${euro(f.monthly_mortgage_cost)}/mes para siempre. Más cara hoy, inmune a las subidas de tipos.`
            : (levCheck.reason || 'No disponible')}">
          Fija</button>`
        : `<button class="btn-lever" disabled title="Este activo no admite financiación">Sin deuda</button>`}
      </div>`;
    wrap.appendChild(el);
  });

  wrap.querySelectorAll('button[data-buy]').forEach(btn => {
    btn.onclick = () => doBuy(btn.dataset.id, btn.dataset.buy, btn.dataset.rate || 'variable');
  });
  wrap.querySelectorAll('button[data-dd]').forEach(btn => {
    btn.onclick = () => {
      const entry = market.find(m => m.asset.id === btn.dataset.dd);
      if (!entry) return;
      const r = engine.investigate(entry.asset);
      if (!r.ok) { toast('No se pudo analizar', r.reason, 'bad'); return; }
      ach.bumpLife('due_diligence');
      if (r.quality === 'scam') ach.bumpLife('scams_dodged');
      toast(
        r.quality === 'scam' ? '🚨 Es un chiringuito'
        : r.quality === 'speculative' ? '🎲 Es una apuesta'
        : '✅ Inversión sólida',
        r.warning || 'El análisis no encuentra nada raro: los números se sostienen.',
        r.quality === 'scam' ? 'bad' : r.quality === 'speculative' ? 'neutral' : 'good');
      if (r.quality === 'scam') showTip('scam');
      render();
    };
  });
}

function doBuy(assetId, financing, rateType = 'variable') {
  const entry = market.find(m => m.asset.id === assetId);
  // el tablón manda: es el precio que el jugador está viendo
  const asset = (entry && entry.asset) || catalog.find(a => a.id === assetId);
  if (!asset) { toast('Oportunidad no disponible', 'Ya no está en el tablón.', 'bad'); return; }
  const res = engine.buyAsset(asset, financing, rateType);
  if (!res.ok) { toast('No se pudo comprar', res.reason, 'bad'); return; }

  ach.bumpLife('assets_bought');
  if (financing === 'leverage') ach.bumpLife('bought_leverage');
  // esperar a que baje el precio (o a tener caja) también es una jugada
  if (entry && entry.left <= MARKET_TTL[1] - 4) ach.bumpLife('patient_buys');

  // aparece el edificio en su distrito (sprite variado; guardamos celda y sprite)
  const placed = city.placeBuilding(asset.category);
  if (placed) { res.instance.cell = placed.cell; res.instance.citySprite = placed.key; city.emitCoins(); }

  // la oportunidad comprada deja su hueco libre en el tablón
  market = market.filter(m => m.asset.id !== assetId);
  fillMarket();

  sfx.play('buy');
  const rateTxt = rateType === 'fixed'
    ? 'hipoteca a tipo fijo (blindada ante subidas)'
    : 'hipoteca a tipo variable (más barata hoy, sigue al mercado)';
  toast('✅ Activo adquirido',
    `${asset.title} · ${financing === 'leverage' ? rateTxt : 'pagado al contado'}`, 'good');
  logActivity(`🫵 Compraste ${asset.title}`, 'good');
  if (engine.ownedAssets.length === 1) showTip('first_asset');
  if (financing === 'leverage') showTip('leverage');
  if (engine.ownedAssets.length === 2) showTip('yield_band');
  if (asset.category === 'real_estate') showTip('amortization');
  renderMarket();
  render();
}

/* -------------------------- PORTFOLIO ----------------------------- */
/* ------------------------ CAMBIAR DE PROFESIÓN --------------------- */
/*
 * La profesión se elige en el minuto cero sin información y decide qué 13 de
 * los 53 activos verás en tu vida. Que se pueda cambiar es lo que convierte esa
 * elección en una puerta en vez de una jaula.
 */
function showRetrain() {
  const cost = engine.retrainCost();
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal">
      <h2>Reciclarse</h2>
      <p class="lead">Volver a formarte cuesta <b>${euro(cost)}</b> y <b>20 de energía</b>, y gasta una jugada
        del mes. A cambio se te abre el catálogo de proyectos del nuevo campo.</p>
      <div class="prof-grid">
        ${DATA.professions.map(pr => {
          const c = engine.canRetrain(pr.id);
          const mine = pr.id === engine.professionId;
          return `<button class="prof-opt ${mine ? 'current' : ''}"
                    ${c.ok ? `data-retrain="${pr.id}"` : 'disabled'}
                    title="${mine ? 'Es tu profesión actual' : (c.ok ? `Cambiar a ${pr.label}` : c.reason)}">
            <span class="prof-em">${pr.emoji}</span>
            <b>${pr.label}${mine ? ' · actual' : ''}</b>
            <span class="prof-desc">${pr.desc}</span>
            ${pr.projects ? `<span class="prof-proj">🔓 ${pr.projects.join(' · ')}</span>` : ''}
          </button>`;
        }).join('')}
      </div>
      <button class="btn-ghost" id="rt-close" style="width:100%;margin-top:14px">Dejarlo como está</button>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#rt-close').onclick = () => ov.remove();
  ov.querySelectorAll('[data-retrain]').forEach(card => {
    card.onclick = () => {
      const pr = DATA.professions.find(x => x.id === card.dataset.retrain);
      const r = engine.retrain(pr.id);
      if (!r.ok) { toast('No se pudo', r.reason, 'bad'); return; }
      ov.remove();
      $('hud-prof').innerHTML = chipHTML(pr.emoji, pr.label);
      $('hud-prof').style.display = pr.id === 'none' ? 'none' : '';
      buildCatalog();
      market = []; fillMarket();
      sfx.play('buy');
      logActivity(`🎓 Te reciclas a ${pr.label}`, 'neutral');
      toast('🎓 Nueva profesión',
        `Ahora eres ${pr.label}. El mercado empieza a ofrecerte sus proyectos.`, 'good');
      render();
    };
  });
}

/* --------------------------- GESTORES ------------------------------ */
/*
 * Comprar tiempo. Cada gestor da una jugada más al mes y cobra un sueldo que
 * entra en tus gastos fijos, así que también sube el listón que tienes que
 * superar. Más manos hoy a cambio de una meta más alta: eso es una decisión.
 */
function renderTeam() {
  const panel = $('panel-team');
  const box = $('team');
  if (!panel || !box) return;
  if (!engine.managersUnlocked()) { panel.style.display = 'none'; return; }
  panel.style.display = '';

  const hire = engine.canHireManager();
  const rows = [];
  for (let i = 0; i < engine.managers; i++) {
    rows.push(`<div class="tm-row">
      <span class="tm-em">🧑‍💼</span>
      <span class="tm-t">Gestor ${i + 1}<span class="tm-d">+1 jugada al mes</span></span>
      <span class="tm-c">${euro(engine.managerSalaries[i] || 0)}/mes</span>
    </div>`);
  }
  const full = engine.managers >= engine.managersMax();
  box.innerHTML = (rows.join('') || '<div class="empty">Trabajas solo. Tres jugadas al mes.</div>') +
    (full
      ? `<div class="hint">Plantilla completa para la ${engine.status().eraLabel}.</div>`
      : `<button class="btn-ghost btn-sm tm-hire" id="btn-hire" ${hire.ok ? '' : 'disabled'}
           title="${hire.ok
             ? 'Sube tus gastos fijos, así que también sube tu meta de IE. A cambio, una jugada más cada mes.'
             : hire.reason}">
           Contratar gestor · ${euro(hire.cost || engine.managerCost())}/mes</button>`) +
    (engine.managers ? `<button class="btn-ghost btn-sm tm-fire" id="btn-fire">Prescindir del último</button>` : '');

  const b = $('btn-hire');
  if (b) b.onclick = () => {
    const r = engine.hireManager();
    if (!r.ok) { toast('No se pudo contratar', r.reason, 'bad'); return; }
    sfx.play('buy');
    logActivity(`🧑‍💼 Contratas un gestor (${euro(r.cost)}/mes)`, 'neutral');
    toast('🧑‍💼 Gestor contratado',
      `Una jugada más al mes por ${euro(r.cost)}. Ojo: sus honorarios entran en tus gastos fijos, así que tu meta de IE sube.`,
      'neutral');
    render();
  };
  const f = $('btn-fire');
  if (f) f.onclick = () => {
    const r = engine.fireManager();
    if (!r.ok) return;
    logActivity('Prescindes de un gestor', 'neutral');
    render();
  };
}

/* --------------------------- ENCARGOS ----------------------------- */
/*
 * Un objetivo a seis o doce meses, con plazo y premio. Es la capa que faltaba:
 * la era es un objetivo a treinta meses y el turno es un objetivo a uno; entre
 * medias no había nada que perseguir.
 */
function renderContract() {
  const box = $('contract');
  if (!box) return;
  const c = engine.contract;

  if (!c) {
    const offers = engine.contractOffers();
    if (!offers.length) { box.innerHTML = '<div class="empty">Sin encargos disponibles.</div>'; return; }
    box.innerHTML = `<div class="ct-intro">Acepta uno. No gasta acciones y puedes dejarlo cuando quieras.</div>` +
      offers.map((o, i) => `
        <div class="ct-offer">
          <div class="ct-top"><span class="ct-em">${o.def.emoji}</span><b>${o.def.title}</b>
            <span class="ct-when">${o.months} meses</span></div>
          <div class="ct-desc">${o.def.desc.replace('{n}', fmtGoal(o.def, o.goal))}</div>
          <div class="ct-reward">🎁 ${o.def.rewardText}</div>
          <button class="btn-ghost btn-sm ct-take" data-take="${i}">Aceptar</button>
        </div>`).join('');
    box.querySelectorAll('button[data-take]').forEach(btn => {
      btn.onclick = () => {
        const o = offers[parseInt(btn.dataset.take, 10)];
        if (!engine.acceptContract(o.def).ok) return;
        logActivity(`${o.def.emoji} Encargo aceptado: ${o.def.title}`, 'neutral');
        render();
      };
    });
    return;
  }

  const prog = engine.contractProgress();
  const done = engine.contractDone();
  const left = engine.contractMonthsLeft();
  const pct = Math.min(100, Math.round(prog / Math.max(1, c.goal) * 100));
  box.innerHTML = `
    <div class="ct-active ${done ? 'done' : left <= 2 ? 'urgent' : ''}">
      <div class="ct-top"><span class="ct-em">${c.def.emoji}</span><b>${c.def.title}</b>
        <span class="ct-when ${left <= 2 ? 'hot' : ''}">${left} ${left === 1 ? 'mes' : 'meses'}</span></div>
      <div class="ct-desc">${c.def.desc.replace('{n}', fmtGoal(c.def, c.goal))}</div>
      <div class="ct-bar"><i style="width:${pct}%"></i></div>
      <div class="ct-prog">${fmtGoal(c.def, prog)} / ${fmtGoal(c.def, c.goal)}</div>
      <div class="ct-reward">🎁 ${c.def.rewardText}</div>
      <div class="buy-row">
        ${done
          ? `<button class="btn-cash" id="ct-claim" style="flex:1">Cobrar recompensa</button>`
          : `<button class="btn-ghost btn-sm" id="ct-drop" style="flex:1">Abandonar</button>`}
      </div>
    </div>`;

  const claim = $('ct-claim');
  if (claim) claim.onclick = () => {
    const r = engine.claimContract();
    if (!r.ok) { toast('Aún no', r.reason, 'bad'); return; }
    sfx.play('buy');
    ach.bumpLife('contracts');
    ach.bumpRun('contracts');
    logActivity(`${r.def.emoji} Encargo cumplido: ${r.def.title}`, 'good');
    toast(`${r.def.emoji} Encargo cumplido`,
      `${r.def.rewardText}.${r.cash ? ` Cobras ${euro(r.cash)}.` : ''}`, 'good');
    render();
  };
  const drop = $('ct-drop');
  if (drop) drop.onclick = () => {
    engine.dropContract();
    logActivity('Encargo abandonado', 'neutral');
    render();
  };
}

/** Los objetivos de dinero se leen en euros; los de contar, en unidades. */
function fmtGoal(def, v) {
  const t = def.goal.type;
  return (t === 'passive' || t === 'cash') ? euro(v) : String(v);
}

/* ----------------------- REAGRUPAR (fusión) ----------------------- */
/*
 * La jugada que convierte acumular en construir. El aviso vive encima de la
 * cartera porque es ahí donde el jugador ve que tiene tres ejemplares iguales,
 * y enseña las dos cifras que importan: lo que aportan tus activos y lo que
 * tienes que poner encima.
 */

/** El activo del escalón superior, resuelto en el catálogo de la era actual. */
function upgradeTarget(upgradeId) {
  return catalog.find(a => (a.baseId || a.id) === upgradeId) || null;
}

function renderMerges() {
  const box = $('merge-box');
  if (!box) return;
  const groups = engine.mergeCandidates()
    .map(g => ({ g, target: upgradeTarget(g.upgradeId) }))
    .filter(x => x.target)
    .map(x => ({ ...x, check: engine.canMerge(x.g.picks, x.target) }))
    // primero lo que puedes cerrar hoy, y de eso lo que menos dinero pide
    .sort((a, b) => (b.check.ok - a.check.ok) || (a.check.extra - b.check.extra));

  if (!groups.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
  box.style.display = '';
  box.innerHTML = `<div class="mg-h">🔀 Reagrupar</div>` + groups.map(({ g, target, check }, i) => {
    const cf = engine.assetNetIncome({ ...target, financials: engine.pricedFinancials(target),
      financing: check.financing, yieldFactor: 1 });
    const pay = check.extra > 0
      ? `pones <b>${euro(check.extra)}</b>`
      : `te devuelven <b>${euro(-check.extra)}</b>`;
    return `
      <div class="mg-row ${check.ok ? '' : 'off'}">
        <img src="${target.sprite}" alt="">
        <div class="mg-t">
          <b>${g.need} × ${g.title}</b> → ${target.title}
          <span class="mg-d">Aportan ${euro(check.contribution)} · ${pay} · rinde ${cf >= 0 ? '+' : ''}${euro(cf)}/mes</span>
        </div>
        <button class="btn-ghost btn-sm mg-go" data-merge="${i}" ${check.ok ? '' : 'disabled'}
                title="${check.ok ? 'Consume una jugada del mes' : check.reason}">
          ${check.ok ? 'Reagrupar' : (check.noActions ? 'Sin acciones' : 'Falta caja')}
        </button>
      </div>`;
  }).join('');

  box.querySelectorAll('button[data-merge]').forEach(btn => {
    btn.onclick = () => {
      const { g, target } = groups[parseInt(btn.dataset.merge, 10)];
      const r = engine.mergeAssets(g.picks, target);
      if (!r.ok) { toast('No se pudo reagrupar', r.reason, 'bad'); return; }
      // la ciudad refleja el cambio: caen los pequeños y sube el grande, con
      // el sprite propio del escalón para que se note que ha crecido
      r.freedCells.forEach(cell => city.removeBuilding(cell));
      const key = (target.sprite || '').split('/').pop().replace(/\.png$/, '');
      const placed = city.placeBuilding(target.category, null, spriteMap[key] ? key : null);
      if (placed) { r.instance.cell = placed.cell; r.instance.citySprite = placed.key; }
      sfx.play('buy');
      ach.bumpRun('merges');
      ach.bumpLife('merges');
      // sin escalón superior = has coronado la cadena, que es el logro gordo
      if (!target.upgrade) ach.bumpRun('merge_top');
      logActivity(`🔀 ${r.merged} × ${g.title} → ${target.title}`, 'good');
      toast('🔀 Reagrupado',
        `${r.merged} × "${g.title}" son ahora ${target.title}.` +
        `${r.extra > 0 ? ` Has puesto ${euro(r.extra)} encima.` : r.extra < 0 ? ` Te sobran ${euro(-r.extra)}.` : ''}`,
        'good');
      render();
    };
  });
}

/* ---------------------- CARTERA: FILTROS Y GRUPOS ------------------ */
/*
 * Con ciento cincuenta activos, una lista plana de una fila por cosa no es una
 * cartera: es un muro. Se agrupan los ejemplares idénticos en una fila con su
 * cashflow sumado, se pueden filtrar y se puede vender un grupo entero de una
 * vez. Antes, deshacerse de doscientos trasteros en pérdidas eran doscientos
 * clics.
 */
let pfFilter = 'all';
const pfOpen = new Set();   // grupos desplegados

const PF_FILTERS = [
  { id: 'all',   label: 'Todos',       test: () => true },
  { id: 'real_estate', label: '🏠',    title: 'Inmuebles',  test: a => a.category === 'real_estate' },
  { id: 'digital_business', label: '💻', title: 'Negocios', test: a => a.category === 'digital_business' },
  { id: 'financial', label: '📈',      title: 'Financieros', test: a => a.category === 'financial' },
  { id: 'losing', label: '⚠️',         title: 'Los que pierden dinero',
    test: a => engine.assetNetIncome(a) < 0 || a.ruined || engine.isVacant(a) },
];

/** Clave de agrupación: el mismo activo, del mismo calibre y con la misma financiación. */
function pfGroupKey(a) {
  return `${a.id}|${a.financing}|${a.rateType || ''}`;
}

function renderFilters(counts) {
  const bar = $('pf-filters');
  if (!bar) return;
  bar.innerHTML = PF_FILTERS.map(f => {
    const n = counts[f.id] || 0;
    return `<button class="pf-f ${pfFilter === f.id ? 'on' : ''}" data-filter="${f.id}"
      title="${f.title || f.label}" ${n ? '' : 'disabled'}>${f.label}${n ? ` <i>${n}</i>` : ''}</button>`;
  }).join('');
  bar.querySelectorAll('button[data-filter]').forEach(b => {
    b.onclick = () => { pfFilter = b.dataset.filter; renderPortfolio(); };
  });
}

function renderPortfolio() {
  renderContract();
  renderTeam();
  renderMerges();
  const wrap = $('portfolio');
  if (!engine.ownedAssets.length) {
    renderFilters({});
    wrap.innerHTML = '<div class="empty">Aún no tienes activos. Compra en el Marketplace.</div>';
    return;
  }

  // cuántos caen en cada filtro (para las pastillas) y qué se enseña ahora
  const counts = {};
  PF_FILTERS.forEach(f => { counts[f.id] = engine.ownedAssets.filter(f.test).length; });
  renderFilters(counts);
  const active = PF_FILTERS.find(f => f.id === pfFilter) || PF_FILTERS[0];
  let visible = engine.ownedAssets.filter(active.test);
  if (!visible.length) { pfFilter = 'all'; visible = engine.ownedAssets; }

  // se agrupan los idénticos: una fila "Trastero ×12" en vez de doce filas
  const groups = new Map();
  visible.forEach(a => {
    const k = pfGroupKey(a);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  });

  wrap.innerHTML = '';
  groups.forEach((list, key) => {
    if (list.length > 1 && !pfOpen.has(key)) { renderPfGroup(wrap, key, list); return; }
    if (list.length > 1) renderPfGroup(wrap, key, list, true);
    list.forEach(a => renderPfItem(wrap, a, list.length > 1));
  });

  bindPortfolioActions(wrap);
}

/** Fila resumen de un grupo de activos idénticos. */
function renderPfGroup(wrap, key, list, open = false) {
  const cf = list.reduce((s, a) => s + engine.assetNetIncome(a), 0);
  const value = list.reduce((s, a) => s + engine.assetTransferValue(a), 0);
  const a0 = list[0];
  const el = document.createElement('div');
  el.className = `pf-group ${open ? 'open' : ''}`;
  el.innerHTML = `
    <img src="${a0.sprite}" alt="">
    <div class="pf-t">${a0.title} <span class="pf-n">×${list.length}</span>
      <span class="pf-gd">${a0.financing === 'leverage'
        ? `hipoteca ${a0.rateType === 'fixed' ? 'fija' : 'variable'}` : 'al contado'} · vale ${euro(value)}</span></div>
    <div class="pf-cf" style="color:${cf >= 0 ? 'var(--green)' : 'var(--red)'}">${cf >= 0 ? '+' : ''}${euro(cf)}</div>
    <div class="pf-actions">
      <button class="btn-ghost btn-sm" data-toggle="${key}" title="Ver uno a uno">${open ? '▾' : '▸'}</button>
      <button class="btn-ghost btn-sm sell" data-sellgroup="${key}"
        title="Pone a la venta los ${list.length} de golpe">Vender ${list.length}</button>
    </div>`;
  wrap.appendChild(el);
}

/** Fila de un activo suelto (o de uno dentro de un grupo desplegado). */
function renderPfItem(wrap, a, nested = false) {
  const cf = engine.assetNetIncome(a);
  const band = engine.incomeBand(a);
  const delta = engine.assetYieldDelta(a);
  const gain = engine.assetGainPct(a);   // plusvalía latente si vendieras hoy
  const wait = engine.liquidityMonths(a);            // lo que tarda en venderse
  const selling = engine.pendingSales.find(x => x.instanceId === a.instanceId);
  // flecha del mes: cómo ha salido este activo dentro de su horquilla
  const arrow = delta > 3 ? `<span class="pf-d up" title="Buen mes: +${delta}% sobre su media">▲</span>`
              : delta < -3 ? `<span class="pf-d down" title="Mal mes: ${delta}% bajo su media">▼</span>`
              : `<span class="pf-d flat" title="Mes en su media">•</span>`;
  let badge = a.financing === 'leverage'
    ? `<span class="badge green">VERDE</span><span class="badge ${a.rateType === 'fixed' ? 'fixed">FIJO' : 'variable">VARIABLE'}</span>`
    : '<span class="badge cash">CONTADO</span>';
  if (a.refinanced) badge += '<span class="badge refi">REFI</span>';
  if (a.ruined) badge += '<span class="badge ruined">💀 A CERO</span>';
  if (engine.isVacant(a)) {
    const m = a.vacantUntil - engine.month;
    badge += `<span class="badge vacant">🚪 VACÍO ${m}m</span>`;
  }
  if (a.rentBonus && a.rentBonus > 1) {
    badge += `<span class="badge review">📈 +${Math.round((a.rentBonus - 1) * 100)}%</span>`;
  }
  if (a.boomed) badge += `<span class="badge boom">🚀 ×${a.boomed}</span>`;
  // botón de refinanciar solo en hipotecas no refinanciadas
  const canRefi = a.financing === 'leverage' && !a.refinanced;
  const refiBtn = canRefi
    ? `<button class="btn-ghost btn-sm" data-refi="${a.instanceId}" title="Baja la cuota un 25% y fija el tipo · comisión ${euro(engine.refiFee(a))}">Refi</button>`
    : '';
  const el = document.createElement('div');
  el.className = `pf-item ${nested ? 'nested' : ''}`;
  el.innerHTML = `
    <img src="${a.sprite}" alt="">
    <div class="pf-t">${a.title} ${badge}</div>
    <div class="pf-cf" style="color:${cf >= 0 ? 'var(--green)' : 'var(--red)'}"
         title="Horquilla: ${euro(band.min)} a ${euro(band.max)}/mes · media ${euro(band.expected)}">
      ${cf >= 0 ? '+' : ''}${euro(cf)} ${arrow}</div>
    <div class="pf-actions">
      ${refiBtn}
      ${selling
        ? `<button class="btn-ghost btn-sm cancel" data-cancel="${a.instanceId}"
             title="Retirar del mercado y quedártelo">En venta · ${selling.months}m ✕</button>`
        : `<button class="btn-ghost btn-sm sell ${gain > 4 ? 'gain' : gain < -4 ? 'loss' : ''}"
        data-sell="${a.instanceId}"
        title="Recuperarías ${euro(engine.assetTransferValue(a) * 0.95)} (${gain >= 0 ? '+' : ''}${gain}% sobre tu capital, con 5% de costes de venta).${
          wait ? ` Tarda ${wait} ${wait === 1 ? 'mes' : 'meses'} en cerrarse: sigue rentando mientras tanto.` : ' Se liquida al instante.'}">
        Vender${wait ? ` <em>${wait}m</em>` : ''}${gain ? ` <em>${gain > 0 ? '+' : ''}${gain}%</em>` : ''}</button>`}
    </div>`;
  wrap.appendChild(el);
}

/** Cuelga los manejadores de toda la cartera pintada. */
function bindPortfolioActions(wrap) {
  wrap.querySelectorAll('button[data-toggle]').forEach(btn => {
    btn.onclick = () => {
      const k = btn.dataset.toggle;
      if (pfOpen.has(k)) pfOpen.delete(k); else pfOpen.add(k);
      renderPortfolio();
    };
  });
  wrap.querySelectorAll('button[data-sellgroup]').forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.sellgroup;
      const list = engine.ownedAssets.filter(a => pfGroupKey(a) === key && !engine.isForSale(a.instanceId));
      let total = 0, n = 0, now = 0;
      list.forEach(a => {
        const cell = a.cell;
        const r = engine.sellAsset(a.instanceId);
        if (!r.ok) return;
        total += r.proceeds; n++;
        if (r.immediate) { now++; if (cell) city.removeBuilding(cell); }
      });
      if (!n) { toast('No se pudo vender', 'Ya estaban todos en venta.', 'bad'); return; }
      toast('🏷️ Grupo a la venta',
        `${n} ${n === 1 ? 'activo' : 'activos'} por ${euro(total)}.` +
        `${now < n ? ' Los inmuebles y negocios tardan en colocarse: siguen rentando mientras tanto.' : ''}`,
        'good');
      logActivity(`🏷️ Pusiste a la venta ${n} × ${list[0].title}`, 'neutral');
      render();
    };
  });
  wrap.querySelectorAll('button[data-refi]').forEach(btn => {
    btn.onclick = () => {
      const r = engine.refinanceAsset(btn.dataset.refi);
      if (r.ok) { ach.bumpLife('refis'); toast('🔧 Hipoteca refinanciada', `Comisión ${euro(r.fee)}. Cuota −25% y tipo fijado (inmune a subidas).`, 'good'); render(); }
      else toast('No se pudo refinanciar', r.reason, 'bad');
    };
  });
  wrap.querySelectorAll('button[data-sell]').forEach(btn => {
    btn.onclick = () => {
      const inst = engine.ownedAssets.find(a => a.instanceId === btn.dataset.sell);
      const cell = inst && inst.cell;
      const r = engine.sellAsset(btn.dataset.sell);
      if (!r.ok) { toast('No se pudo vender', r.reason, 'bad'); return; }
      if (r.immediate) {
        if (cell) city.removeBuilding(cell);
        toast('Activo vendido', `Recuperas ${euro(r.proceeds)} al instante: los financieros son líquidos.`, 'good');
      } else {
        toast('🏷️ Puesto en venta',
          `${inst.title} tardará ${r.months} ${r.months === 1 ? 'mes' : 'meses'} en colocarse. Sigue rentando hasta que cierre, pero los ${euro(r.proceeds)} aún no están en tu caja.`,
          'neutral');
        showTip('liquidity');
      }
      render();
    };
  });
  wrap.querySelectorAll('button[data-cancel]').forEach(btn => {
    btn.onclick = () => {
      engine.cancelSale(btn.dataset.cancel);
      toast('Venta retirada', 'Te quedas el activo.', 'neutral');
      render();
    };
  });
}

/* ---------------------------- TURNO ------------------------------- */
function endTurn() {
  if (ended || awaitingChoice) return;   // sin decidir el dilema no corre el mes
  // el evento del jugador se elige ANTES: si es un dilema, hay que decidir
  const ev = engine.pickEvent();
  if (engine.isDilemma(ev)) askDilemma(ev);
  else resolveTurn(ev, null);
}

/**
 * Plantea un dilema y bloquea el paso del tiempo hasta que se responda. Sin
 * este cerrojo, pulsar "avanzar" con la pregunta en pantalla apilaba modales
 * y el mes no corría: el juego parecía colgado.
 */
function askDilemma(ev) {
  if (AUTO_MODE) { resolveTurn(ev, engine.autoDilemmaChoice(ev)); return; }
  awaitingChoice = true;
  showDilemma(ev, (choiceIndex) => { awaitingChoice = false; resolveTurn(ev, choiceIndex); });
}

/* -------------------------- AVANCE RÁPIDO -------------------------- */
/*
 * Casi la mitad de los meses no había nada que hacer y aun así había que pulsar
 * "pasar de mes". Esto encadena meses solo y frena en cuanto vuelve a haber una
 * decisión: un dilema, una oportunidad que ya puedes pagar, una era ganada o un
 * apuro que conviene mirar. Nunca más de un año de un tirón.
 */
const FF_MAX = 12;

/**
 * ¿Hay algo en el tablón que puedas comprar SIN quedarte sin colchón? Poder
 * pagar la entrada justa no es una jugada: si te deja a cero, el mes siguiente
 * te hunde. Por eso el avance rápido no frena por una oportunidad al límite.
 */
function playableCost(a) {
  const f = engine.pricedFinancials(a);
  if (a.leverage_allowed && f.mortgage_available <= engine.creditLimit()) {
    return f.down_payment_required;
  }
  return f.total_price;
}

function hasPlayableOffer() {
  if (engine.actionsLeft() <= 0) return false;
  const cushion = engine.fixedExpenses();   // un mes de gastos, siempre a salvo
  return market.some(m => engine.cash - playableCost(m.asset) >= cushion);
}

/** Motivo por el que el avance rápido debe parar, o null si puede seguir. */
function fastForwardStop() {
  if (ended) return 'la partida ha terminado';
  if (hasPlayableOffer()) return 'hay una oportunidad que ya puedes pagar';
  if (engine.isBurnout()) return 'estás en burnout: cuídate antes de seguir';
  if (engine.cash < 0) return 'tu caja está en números rojos';
  return null;
}

function fastForward() {
  if (ended || awaitingChoice) return;
  const fromMonth = engine.month;
  const fromCash = engine.cash;
  let reason = 'ya has avanzado un año';
  let dilemma = null;   // si el avance choca con una decisión, se plantea al salir

  fastMode = true;
  try {
    for (let i = 0; i < FF_MAX; i++) {
      // el evento se sortea aquí y se pasa entero: si sale un dilema hay que
      // decidir, así que se corta el avance y se plantea con su modal de siempre
      const ev = engine.pickEvent();
      if (engine.isDilemma(ev)) { dilemma = ev; reason = 'te toca decidir'; break; }
      resolveTurn(ev, null);
      const stop = fastForwardStop();
      if (stop) { reason = stop; break; }
    }
  } finally {
    fastMode = false;
  }

  const months = engine.month - fromMonth;
  if (!months && !dilemma) { endTurn(); return; }   // no cabía ni un mes: pasa uno normal
  render();
  if (ended) return;                               // el fin de partida ya tiene su pantalla

  if (months) {
    const delta = Math.round(engine.cash - fromCash);
    sfx.play('month');
    city.emitCoins();
    toast(`⏩ ${months} ${months === 1 ? 'mes' : 'meses'} después`,
      `Caja ${delta >= 0 ? '+' : ''}${euro(delta)}. Paramos porque ${reason}.`,
      delta >= 0 ? 'good' : 'bad');
    logActivity(`⏩ Avanzaste ${months} ${months === 1 ? 'mes' : 'meses'} (${reason})`, 'neutral');
  }

  // la decisión que cortó el avance se plantea de verdad: prometer "te toca
  // decidir" y no enseñar nada sería mentir
  if (dilemma) askDilemma(dilemma);
}

/** ¿Toca narrar el mes? En demos y en avance rápido, no: sería un bombardeo. */
function quiet() { return AUTO_MODE || fastMode; }

function resolveTurn(ev, choiceIndex) {
  const wasBurnout = engine.isBurnout();
  const snap = engine.endTurn(ev, choiceIndex);

  // marcas del mes que alimentan los logros de resistencia
  if (engine.isBurnout() && !wasBurnout) ach.bumpRun('burnouts');
  if (engine.cash < 0) ach.setRun('was_negative', true);
  const tone = ev ? ev.tone : 'neutral';
  let desc = ev ? ev.description : '';
  if (snap.adj && snap.adj._vacancyAsset) desc += ` (${snap.adj._vacancyAsset})`;
  // los sucesos de activo dicen A CUÁL le ha pasado: es media gracia del suceso
  if (snap.adj && snap.adj._shock) desc += ` → ${snap.adj._shock}`;
  if (snap.contractExpired && !quiet()) {
    setTimeout(() => toast('⌛ Encargo caducado',
      `Se acabó el plazo de "${snap.contractExpired.title}". Puedes aceptar otro.`, 'bad'), 4600);
  }
  if (snap.contractExpired) logActivity(`⌛ Caducó el encargo: ${snap.contractExpired.title}`, 'bad');
  if (snap.adj && snap.adj._choice) desc += ` → ${snap.adj._choice}`;

  if (!fastMode) { city.emitCoins(); sfx.play('month'); }
  $('hud-month').textContent = engine.status().dateLabel;

  // ventas que se cierran este mes: entra el dinero y desaparece el edificio
  (snap.salesClosed || []).forEach(sale => {
    if (sale.cell) city.removeBuilding(sale.cell);
    logActivity(`🏷️ Vendido: ${sale.title} (+${euro(sale.proceeds)})`, 'good');
  });

  // ruinas y despegues: lo que pasa cuando una apuesta se resuelve
  (snap.outcomes || []).forEach((o, i) => {
    ach.bumpRun(o.type === 'ruin' ? 'ruins' : 'booms');
    if (o.type === 'ruin') {
      if (!fastMode) sfx.play('ruin');
      logActivity(`💀 ${o.asset.title} se fue a cero`, 'bad');
      if (!quiet()) setTimeout(() => toast(
        o.scam ? '🚨 Era una estafa' : '💀 La apuesta salió mal',
        o.scam
          ? `"${o.asset.title}" ha desaparecido con tu dinero. No queda nada que vender.`
          : `"${o.asset.title}" deja de generar renta. Puedes venderlo, pero solo por el residuo.`,
        'bad'), 4600 + i * 2400);
    } else {
      logActivity(`🚀 ${o.asset.title} despegó (+40% de renta)`, 'good');
      if (!quiet()) setTimeout(() => toast('🚀 Despegue',
        `"${o.asset.title}" ha escalado: su renta sube un 40% para siempre.`, 'good'), 4600 + i * 2400);
    }
  });

  // cambio de fase del ciclo: es la noticia más importante del mes
  if (snap.newPhase) {
    const p = snap.newPhase;
    if (!fastMode) sfx.play('cycle');
    logActivity(`${p.emoji} Nueva fase: ${p.label}`, p.tone === 'good' ? 'good' : p.tone === 'bad' ? 'bad' : 'neutral');
    if (!quiet()) setTimeout(() => toast(`${p.emoji} ${p.label}`, p.desc,
      p.tone === 'good' ? 'good' : p.tone === 'bad' ? 'bad' : 'neutral'), 4600);
    if (p.id === 'recession') showTip('cycle_buy');
    if (p.id === 'peak') showTip('cycle_sell');
  }

  const sign = snap.cashflow >= 0 ? '+' : '';
  if (!fastMode) {
    toast(`📅 Mes ${engine.month - 1} · ${ev ? ev.title : 'Liquidación'}`,
      `${desc}  ·  Cashflow del mes: ${sign}${euro(snap.cashflow)}`, tone);
  }
  if (ev && ev.title) logActivity(`📅 ${ev.title}`, tone);

  // los rivales miran TU tablón antes que nada: lo que dejaste ahí con el aviso
  // "🔥 Ana puede permitírselo" es exactamente lo que se pueden llevar ahora
  const sniped = botsSnipeMarket();

  // turno de los oponentes IA (compran, se cuidan y resuelven sus eventos)
  bots.forEach(b => {
    const bought = takeBotTurn(b.engine, catalog, DATA.lifestyle, DATA.vehicles, b.aggr, DATA.gigs) || [];
    b.engine.endTurn();
    // la macroeconomía es del mundo, no de cada jugador: todos viven el mismo ciclo
    b.engine.setCycle(engine.cycleIndex, engine.cycleLeft);
    bought.forEach(t => logActivity(`${b.emoji} ${b.name} compró ${t}`, 'neutral'));
    if (b.engine.hasLost()) logActivity(`${b.emoji} ${b.name} abandonó la partida 💥`, 'bad');
  });

  // el catálogo sigue a la inflación, y el tablón envejece: lo que no compraste
  // no te espera para siempre
  buildCatalog();
  tickMarket();
  refreshP2P();
  render();
  // el aviso de "te lo quitaron" espera a que pase el toast del evento del mes
  if (sniped.length && !quiet()) {
    const s0 = sniped[0];
    setTimeout(() => { sfx.play('alert'); toast('⚡ Te lo quitaron',
      `${s0.b.emoji} ${s0.b.name} compró ${s0.a.title}` +
      `${sniped.length > 1 ? ` (y ${sniped.length - 1} más)` : ''}. Las oportunidades no esperan.`, 'bad'); }, 4600);
  }
  checkEnd();
}

/* ------------------------ DILEMA (elección) ----------------------- */
function showDilemma(ev, cb) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal dilemma">
      <div class="dil-tag">🤔 Decisión del mes</div>
      <h2>${ev.title}</h2>
      <p class="lead">${ev.description}</p>
      <div class="dil-choices">
        ${ev.choices.map((c, i) => `
          <button class="dil-choice" data-i="${i}">
            <span class="dil-label">${c.label}</span>
            <span class="dil-fx">${dilemmaEffects(c)}</span>
          </button>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelectorAll('.dil-choice').forEach(btn => {
    btn.onclick = () => { ov.remove(); cb(parseInt(btn.dataset.i, 10)); };
  });
}

function dilemmaEffects(c) {
  const parts = [];
  if (c.cash) parts.push(`<b class="${c.cash < 0 ? 'red' : 'green'}">${c.cash < 0 ? '' : '+'}${euro(c.cash)}</b>`);
  if (c.happiness) parts.push(`<b class="${c.happiness < 0 ? 'red' : 'green'}">${c.happiness < 0 ? '' : '+'}${c.happiness} 😊</b>`);
  if (c.energy) parts.push(`<b class="${c.energy < 0 ? 'red' : 'green'}">${c.energy < 0 ? '' : '+'}${c.energy} ⚡</b>`);
  if (c.salaryBoost) parts.push(`<b class="green">+${Math.round(c.salaryBoost * 100)}% sueldo</b>`);
  return parts.join(' · ');
}

/* ------------------------- FEED DE ACTIVIDAD ---------------------- */
function logActivity(text, tone = 'neutral') {
  activityLog.unshift({ text, tone, month: engine.month });
  if (activityLog.length > 12) activityLog.pop();
}
function renderActivity() {
  const wrap = $('activity');
  if (!wrap) return;
  if (!activityLog.length) { wrap.innerHTML = '<div class="empty">Aún no hay movimientos.</div>'; return; }
  wrap.innerHTML = activityLog.map(a =>
    `<div class="act-item ${a.tone}"><span class="act-m">m${a.month}</span> ${a.text}</div>`).join('');
}

/* --------------------------- MERCADO P2P -------------------------- */
/*
 * Un traspaso NO es "comprar un piso barato": compras el CAPITAL del rival y te
 * subrogas en su hipoteca. Por eso el precio se calcula sobre la equity (no
 * sobre el precio del inmueble) y la tarjeta enseña siempre la deuda que asumes.
 * Un rival solo malvende si está ahogado; si no, pide prima sobre el mercado.
 */
const P2P_MAX_OFFERS = 2;          // como mucho dos tratos sobre la mesa a la vez
const P2P_URGENT_DISCOUNT = [0.08, 0.16];   // rebaja de quien necesita liquidez YA
const P2P_NORMAL_PREMIUM = [-0.03, 0.09];   // negativo = ligera rebaja; normalmente prima

function refreshP2P() {
  p2pOffers = [];
  shuffleArr(bots).forEach(b => {
    if (p2pOffers.length >= P2P_MAX_OFFERS) return;
    const owned = b.engine.ownedAssets;
    if (owned.length < 2) return;
    const urgent = b.engine.cash < b.engine.fixedExpenses();
    // sin apuros solo vende de vez en cuando; ahogado, saca algo casi siempre
    if (Math.random() > (urgent ? 0.85 : 0.22)) return;

    // ahogado suelta su peor activo; si reequilibra, uno cualquiera
    const a = urgent
      ? owned.slice().sort((x, y) => b.engine.assetNetIncome(x) - b.engine.assetNetIncome(y))[0]
      : owned[Math.floor(Math.random() * owned.length)];

    const fair = b.engine.assetTransferValue(a);
    const adj = urgent ? -rand(...P2P_URGENT_DISCOUNT) : rand(...P2P_NORMAL_PREMIUM);
    const fees = Math.round(fair * engine.TRANSFER_COST_PCT);   // notaría/gestión
    const price = Math.max(1, Math.round(fair * (1 + adj))) + fees;

    p2pOffers.push({
      bot: b, instanceId: a.instanceId, asset: a, financing: a.financing,
      price, fees, urgent,
      equity: Math.round(engine.assetEquity(a)),
      deltaPct: Math.round(adj * 100),
      credit: engine.canAssumeMortgage(a),
    });
  });
}

function buyP2P(idx) {
  const o = p2pOffers[idx];
  if (!o) return;
  if (!o.credit.ok) { toast('Hipoteca no asumible', o.credit.reason, 'bad'); return; }
  if (engine.cash < o.price) { toast('Sin liquidez', `Necesitas ${euro(o.price)} para cerrar este trato.`, 'bad'); return; }

  // pago y transferencia del activo del bot al jugador (con su hipoteca)
  engine.cash -= o.price;
  o.bot.engine.cash += o.price - o.fees;   // la notaría no se la lleva el vendedor
  o.bot.engine.ownedAssets = o.bot.engine.ownedAssets.filter(x => x.instanceId !== o.instanceId);

  const inst = engine.acquireAsset(o.asset, o.financing, `p2p${++p2pSeq}`);
  const placed = city.placeBuilding(o.asset.category);
  if (placed) { inst.cell = placed.cell; inst.citySprite = placed.key; city.emitCoins(); }

  p2pOffers.splice(idx, 1);
  const mort = o.financing === 'leverage'
    ? ` Te subrogas en una hipoteca de ${euro(o.asset.financials.mortgage_available)}.` : '';
  sfx.play('buy');
  toast('🤝 Traspaso cerrado',
    `Compraste el capital de "${o.asset.title}" a ${o.bot.emoji} ${o.bot.name} por ${euro(o.price)}.${mort}`, 'good');
  logActivity(`🤝 Traspaso: ${o.asset.title} de ${o.bot.name}`, 'good');
  ach.bumpLife('p2p_deals');
  if (o.urgent) ach.bumpLife('p2p_urgent');
  if (o.financing === 'leverage') showTip('p2p_assume');
  render();
}

function renderP2P() {
  const panel = $('p2p-panel');
  const wrap = $('p2p');
  if (!p2pOffers.length) { panel.style.display = 'none'; wrap.innerHTML = ''; return; }
  panel.style.display = '';
  wrap.innerHTML = p2pOffers.map((o, i) => {
    const f = o.asset.financials;
    const band = engine.incomeBand(o.asset);
    const lev = o.financing === 'leverage';
    // etiqueta honesta: rebaja o prima sobre el valor de mercado del capital
    const tag = o.deltaPct < 0
      ? `<b style="color:var(--green)">${o.deltaPct}% sobre mercado</b>`
      : o.deltaPct > 0 ? `<b style="color:var(--amber)">+${o.deltaPct}% de prima</b>`
      : 'a precio de mercado';
    const blocked = !o.credit.ok || engine.cash < o.price;
    return `
    <div class="p2p-offer ${o.urgent ? 'urgent' : ''}">
      <img src="${o.asset.sprite}" alt="">
      <div class="p2p-info">
        <div class="p2p-title">${o.asset.title}</div>
        <div class="p2p-meta">${o.bot.emoji} ${o.bot.name} ${o.urgent
          ? '· <b style="color:var(--red)">liquidez urgente</b>' : '· reequilibra cartera'}</div>
        <div class="p2p-nums">Pagas <b>${euro(o.price)}</b> por el capital · ${tag}
          <small>(incl. ${euro(o.fees)} de gastos)</small></div>
        <div class="p2p-sub">${lev
          ? `⚠️ Asumes su hipoteca de <b>${euro(f.mortgage_available)}</b> (${euro(engine.mortgageCostOf(o.asset))}/mes)`
          : `Activo libre de deuda · valor ${euro(f.total_price)}`}</div>
        <div class="p2p-sub">Renta neta entre <b class="green">${euro(band.min)}</b> y
          <b class="green">${euro(band.max)}</b>/mes</div>
        ${o.credit.ok ? '' : `<div class="p2p-sub red">🚫 ${o.credit.reason}</div>`}
      </div>
      <button class="btn-lever btn-sm" data-p2p="${i}" ${blocked ? 'disabled' : ''}>Traspasar</button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('button[data-p2p]').forEach(b => b.onclick = () => buyP2P(+b.dataset.p2p));
}

function renderStandings() {
  const wrap = $('standings');
  if (!wrap) return;
  const rows = [
    { name: 'Tú', emoji: engine.profile.emoji, ie: engine.emancipationIndex(),
      assets: engine.ownedAssets.length, me: true },
    ...bots.map(b => ({ name: b.name, emoji: b.emoji, ie: b.engine.emancipationIndex(),
      assets: b.engine.ownedAssets.length, me: false })),
  ].sort((a, b) => b.ie - a.ie);

  wrap.innerHTML = rows.map((r, i) => `
    <div class="rank-row ${r.me ? 'me' : ''}">
      <span class="rk">${i + 1}</span>
      <span class="rk-name">${r.emoji} ${r.name}</span>
      <div class="rk-bar"><i style="width:${Math.min(100, r.ie / engine.winTargetIE() * 100)}%"></i></div>
      <span class="rk-ie">${r.ie.toFixed(0)}%</span>
    </div>`).join('');
}

/** Apunta en el meta-progreso lo que consiguió esta victoria. */
function recordWin(s) {
  ach.bumpLife('wins');
  ach.addLifeSet('profiles_won', engine.profile.id);
  ach.minLife('best_win_months', engine.month - 1);
  if (s.happiness >= 70) ach.bumpLife('balanced_wins');
  if (!ach.run.burnouts) ach.bumpLife('clean_wins');
  if (!ach.run.bought_car) ach.bumpLife('carfree_wins');
  checkAchievements();
}

function checkEnd() {
  if (ended) return;
  const s = engine.status();
  if (s.won) {
    ended = true;
    recordWin(s);
    // coronar la décima era es el final de la campaña, no una era más
    if (engine.campaignComplete()) {
      ach.bumpLife('campaigns');
      ach.bumpRun('campaign');
      endModal('👑 Has completado la campaña',
        `Diez eras, ${s.age} años y un Indicador de Emancipación del <b>${s.ie}%</b>.
         Empezaste con ${euro(engine.profile.starting_cash)} y un sueldo; terminas con un patrimonio que
         mantiene una vida que al empezar ni te planteabas. <b>Esto era el juego.</b>`,
        true, true, false, true);
      return;
    }
    const first = s.era === 1;
    endModal(first ? '🏆 ¡Libertad alcanzada!' : `🏆 ${s.eraLabel} superada`,
      `Has llegado a un Indicador de Emancipación del <b>${s.ie}%</b> con
       ${s.cushionMonths} meses de colchón. ${first
         ? 'Tus activos pagan tu vida. Eres libre.'
         : `Tu patrimonio aguanta un nivel de vida que antes era inalcanzable. Te quedan ${s.campaignEras - s.era} eras para completar la campaña.`}`,
      true, true);
    return;
  }
  if (s.lost) {
    ended = true;
    if (s.lossReason === 'abandono') {
      endModal('😔 Tiraste la toalla',
        `Tu felicidad llegó a 0: te quemaste por el camino y abandonaste el sueño.
         Recuerda: construir libertad sin cuidar tu bienestar no es sostenible. Descansa y disfruta también.`, false);
    } else {
      endModal('💥 Insolvencia',
        `Tu caja cayó a ${euro(s.cash)}. El exceso de deuda o los imprevistos ahogaron tu tesorería.
         Vuelve a intentarlo ajustando el apalancamiento.`, false);
    }
    return;
  }
  const botWinner = bots.find(b => b.engine.hasWon() && !rivalWinsSeen.includes(b.name));
  if (botWinner) {
    ended = true;
    rivalWinsSeen.push(botWinner.name);
    // a partir de la 2ª era la derrota por rival no es definitiva: puedes seguir
    // tu partida (quizá estás a media jugada de capitalización y el IE baja a ratos)
    const canResume = s.era > 1;
    endModal(`🤖 ${botWinner.name} llegó primero`,
      `Tu rival <b>${botWinner.emoji} ${botWinner.name}</b> alcanzó ${canResume ? `la meta de la ${s.eraLabel}` : 'la libertad financiera'} antes que tú.${canResume
        ? ' Pero esto no tiene por qué acabarse aquí.'
        : ' Afina tu estrategia de apalancamiento y diversificación para la próxima.'}`,
      false, false, canResume);
  }
}

function computeEndStats() {
  const equity = engine.ownedAssets.reduce((s, a) =>
    s + (a.financing === 'leverage' ? a.financials.down_payment_required : a.financials.total_price), 0);
  // ranking consciente de la victoria: quien ha ganado va primero, luego por IE
  const players = [{ won: engine.hasWon(), ie: engine.emancipationIndex(), me: true },
    ...bots.map(b => ({ won: b.engine.hasWon(), ie: b.engine.emancipationIndex() }))]
    .sort((a, b) => (b.won - a.won) || (b.ie - a.ie));
  return {
    months: engine.month - 1,
    ie: engine.status().ie,
    assets: engine.ownedAssets.length,
    netWorth: Math.round(engine.cash + equity),
    passive: Math.round(engine.netPassiveIncome()),
    vehicle: engine.taxVehicle === 'company' ? 'Sociedad' : 'Persona física',
    rank: players.findIndex(p => p.me) + 1,
    total: players.length,
  };
}

/**
 * @param {boolean} win          ¿victoria o derrota?
 * @param {boolean} canContinue  ofrecer encadenar la siguiente era (Modo Legado)
 * @param {boolean} canResume    ofrecer seguir la misma era pese a la derrota
 */
function endModal(title, html, win, canContinue = false, canResume = false, finale = false) {
  sfx.play(win ? 'win' : 'lose');
  if (!canContinue && !canResume) clearSave();
  const st = computeEndStats();
  const rankTxt = ['🥇 1º', '🥈 2º', '🥉 3º'][st.rank - 1] || `${st.rank}º`;
  const s = engine.status();

  // puntúa y envía a la liga (clasificación persistente)
  const score = computeScore({
    won: win, months: st.months, netWorth: st.netWorth, ie: st.ie,
    happiness: s.happiness, energy: s.energy, rank: st.rank, profileId: engine.profile.id,
    scoreMult: engine.mode.scoreMult, achPoints: ach.progress().points,
  });
  const lb = submitScore({
    name: 'Tú', emoji: engine.profile.emoji, profile: engine.profile.id,
    score, months: st.months,
  });

  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal end">
      <div style="font-size:60px;text-align:center">${win ? '🏆' : '💥'}</div>
      <h2 style="text-align:center">${title}</h2>
      <p class="lead" style="text-align:center">${html}</p>
      <div class="score-banner">
        <div><span>Puntuación</span><b>${score.toLocaleString('es-ES')}</b></div>
        <div><span>Puesto en la liga</span><b>#${lb.rank} <small>de ${lb.total}</small></b></div>
      </div>
      <div class="end-stats">
        <div><span>Meses jugados</span><b>${st.months}</b></div>
        <div><span>IE final</span><b>${st.ie}%</b></div>
        <div><span>Renta pasiva</span><b>${euro(st.passive)}/mes</b></div>
        <div><span>Activos</span><b>${st.assets}</b></div>
        <div><span>Patrimonio</span><b>${euro(st.netWorth)}</b></div>
        <div><span>Puesto en la carrera</span><b>${rankTxt} de ${st.total}</b></div>
      </div>
      ${finale ? `
      <div class="era-teaser finale">
        <b>Y a partir de aquí, lo que quieras.</b> El modo infinito encadena eras sin
        techo: el listón no deja de subir y la puntuación tampoco. Es el terreno de
        juego de la liga, para quien quiera ver hasta dónde aguanta.
      </div>` : ''}
      ${canContinue && !finale ? `
      <div class="era-teaser">
        <b>¿Sigues?</b> Conservas caja, activos y patrimonio — pero también subes de
        nivel de vida: tu día a día se encarece hasta que lo que ya tienes cubre
        solo la mitad de la nueva vida. Vuelve a haber partida, a una escala mayor,
        con mercado más grande y más crédito. Las eras no se acaban.
      </div>` : ''}
      ${canResume ? `
      <div class="era-teaser">
        <b>¿Lo dejas aquí?</b> Que tu rival llegue antes no borra lo que has construido:
        puedes seguir esta misma era con tu caja, tus activos y tus deudas donde están
        — útil si estabas a media jugada de capitalizar o vender. Al alcanzar la meta
        seguirás encadenando eras; solo el oro de esta ronda se lo lleva otro.
      </div>` : ''}
      <div class="end-actions">
        <button class="btn-ghost" id="btn-lb">🏆 Clasificación</button>
        <button class="btn-ghost" id="btn-ach-end">🏅 Logros <small>${ach.progress().unlocked}/${ach.progress().total}</small></button>
        ${canContinue
          ? `<button class="btn-primary" id="btn-continue" style="flex:1">${finale ? '♾️ Modo infinito' : '▶️ Continuar · Nueva era'}</button>
             <button class="btn-ghost" id="btn-again">${finale ? 'Terminar aquí' : 'Cerrar partida'}</button>`
          : canResume
            ? `<button class="btn-primary" id="btn-keep-playing" style="flex:1">▶️ Seguir jugando</button>
               <button class="btn-ghost" id="btn-again">Cerrar partida</button>`
            : `<button class="btn-primary" id="btn-again" style="flex:1">Jugar otra vez</button>`}
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#btn-again').onclick = () => { clearSave(); location.href = location.pathname; };
  ov.querySelector('#btn-lb').onclick = () => showLeaderboard();
  ov.querySelector('#btn-ach-end').onclick = () => showAchievementsGallery();
  const contBtn = ov.querySelector('#btn-continue');
  if (contBtn) contBtn.onclick = () => { ov.remove(); if (finale) engine.endless = true; startNextEra(); };
  const resBtn = ov.querySelector('#btn-keep-playing');
  if (resBtn) resBtn.onclick = () => { ov.remove(); resumeAfterRival(); };
}

/**
 * Sigue la partida tras la victoria de un rival: no se toca nada del estado,
 * solo se reabre el turno. Si más adelante gana otro rival volverá a preguntar.
 */
function resumeAfterRival() {
  ended = false;
  logActivity('💪 Sigues en la carrera: la meta no se ha movido, tú tampoco.', 'good');
  render();
  saveGame();
}

/* --------------------------- MODO LEGADO -------------------------- */
/**
 * Encadena la siguiente era sin cortar la partida: sube el listón para ti y
 * para los rivales, escala el mercado y sigue jugando con el mismo patrimonio.
 */
function startNextEra() {
  const info = engine.startNewEra();
  bots.forEach(b => b.engine.startNewEra());   // los rivales suben contigo
  buildCatalog();
  ended = false;
  rivalWinsSeen = [];                          // meta nueva: sus victorias vuelven a contar

  logActivity(`🚀 Comienza la ${info.label}: meta ${info.targetTo}% de IE.`, 'good');
  refreshMarket();
  render();
  saveGame();

  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal era-modal">
      <div style="font-size:56px;text-align:center">🚀</div>
      <h2 style="text-align:center">${info.label}</h2>
      <p class="lead" style="text-align:center">
        Conservas todo lo construido — pero tu vida sube de nivel con tu patrimonio.
        Tu IE arranca en torno al <b>${Math.round(ERA_START_RATIO * 100)}%</b> del nuevo
        objetivo: hay partida otra vez, a mayor escala.</p>
      <div class="era-grid">
        <div class="era-up"><span>Meta de IE</span><b>${info.targetFrom}% → ${info.targetTo}%</b></div>
        <div class="era-up"><span>Nivel de vida</span><b>+${euro(info.lifeAdd)}/mes</b></div>
        <div class="era-up"><span>Imprevistos</span><b>+${info.riskPct}% de impacto</b></div>
        <div class="era-down"><span>Límite de crédito</span><b>${euro(info.creditFrom)} → ${euro(info.creditTo)}</b></div>
        <div class="era-down"><span>Mercado</span><b>Activos de mayor calibre</b></div>
        <div class="era-down"><span>Trabajos extra</span><b>Disponibles</b></div>
      </div>
      <div class="end-actions">
        <button class="btn-primary" id="btn-era-go" style="flex:1">Seguir construyendo</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#btn-era-go').onclick = () => ov.remove();
}

/* --------------------------- LIGA / RANKING ----------------------- */
function showLeaderboard() {
  const rows = topScores(20);
  const profName = { corporate: '💼', freelance: '🧑‍💻', investor: '🌱' };
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal lb-modal">
      <h2>🏆 Clasificación · Liga</h2>
      <p class="lead">Cada partida puntúa y escala en la liga. Compite contra otros aspirantes
        a la libertad financiera. La liga no termina: supera tu mejor marca.</p>
      <div class="lb-list">
        ${rows.map((r, i) => `
          <div class="lb-row ${r.me ? 'me' : ''}">
            <span class="lb-rank">${['🥇', '🥈', '🥉'][i] || (i + 1)}</span>
            <span class="lb-name">${r.emoji} ${r.name}${r.me ? ' <small>(tú)</small>' : ''}</span>
            <span class="lb-prof">${profName[r.profile] || ''}</span>
            <span class="lb-mo">${r.months ? r.months + ' m' : '—'}</span>
            <span class="lb-score">${r.score.toLocaleString('es-ES')}</span>
          </div>`).join('')}
      </div>
      <button class="btn-primary" id="lb-close" style="width:100%;margin-top:14px">Cerrar</button>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#lb-close').onclick = () => ov.remove();
}

/* ------------------ ACCIONES DEUDA (liquidez) --------------------- */
function wireDebtButtons() {
  $('btn-loan').onclick = () => {
    engine.takeConsumerLoan(5000);
    ach.bumpRun('red_loans');
    toast('Préstamo de consumo', 'Entran 5.000 € a caja, pero suma DEUDA ROJA que penaliza tu IE.', 'bad');
    showTip('red_debt');
    render();
  };
  $('btn-repay').onclick = () => {
    if (!engine.redDebts.length) { toast('Sin deuda roja', 'No tienes préstamos de consumo que amortizar.', 'neutral'); return; }
    const r = engine.repayRedDebt(engine.redDebts[0].id);
    if (r.ok) { toast('Deuda roja amortizada', 'Has cancelado un préstamo de consumo.', 'good'); render(); }
    else toast('No se pudo amortizar', r.reason, 'bad');
  };
  $('btn-incorporate').onclick = () => showTaxAdvisor();
  $('btn-vehicle').onclick = showVehicleChooser;
}

/* ---------------------------- RENDER ------------------------------ */
function render() {
  const s = engine.status();
  const salary = engine.effectiveSalaryBase();

  // Barra de libertad
  $('ie-value').textContent = `${s.ie}%`;
  const pct = Math.min(100, (s.ie / s.targetIE) * 100);
  $('ie-bar').style.width = pct + '%';
  $('ie-target-sub').textContent = s.targetIE;
  $('ie-target-note').textContent = s.targetIE;

  // Modo Legado: el chip de era solo aparece a partir de la segunda
  const eraChip = $('hud-era-chip');
  if (eraChip) {
    eraChip.style.display = s.era > 1 ? '' : 'none';
    $('hud-era').textContent = s.era;
    eraChip.title = s.eraLabel;
  }

  // Tesorería
  $('cash').textContent = euro(s.cash);
  const cf = engine.netMonthlyCashflow(salary);
  const cfEl = $('cashflow');
  cfEl.textContent = (cf >= 0 ? '+' : '') + euro(cf);
  cfEl.className = 'val ' + (cf >= 0 ? 'green' : 'red');
  $('cushion').textContent = s.cushionMonths;

  // Flujo mensual (la suma cuadra con el cashflow neto)
  $('salary').textContent = '+' + euro(salary);
  $('passive').textContent = '+' + euro(s.netPassiveIncome);
  $('expenses').textContent = '−' + euro(s.fixedExpenses);
  $('flow-vehicle').textContent = '−' + euro(s.vehicleCost);
  $('flow-red').textContent = '−' + euro(s.redDebt);

  renderTax(s);
  renderInsurance(s);
  renderDistricts();
  $('flow-insurance').textContent = '−' + euro(s.insuranceCost);
  const netEl = $('flow-net');
  netEl.textContent = (cf >= 0 ? '+' : '−') + euro(Math.abs(cf));
  netEl.className = 'val ' + (cf >= 0 ? 'green' : 'red');

  // Deuda verde/roja
  const totalDebt = s.greenDebt + s.redDebt || 1;
  $('db-green').style.width = (s.greenDebt / totalDebt * 100) + '%';
  $('db-red').style.width = (s.redDebt / totalDebt * 100) + '%';
  $('green-lbl').textContent = euro(s.greenDebt) + '/mes';
  $('red-lbl').textContent = euro(s.redDebt) + '/mes';

  // Acciones del mes: el recurso que de verdad obliga a priorizar
  renderActions(s);
  renderCycle(s);

  // HUD (desktop chips)
  $('hud-assets').textContent = s.assetsCount;
  const ap = ach.progress();
  $('ach-txt').textContent = ` Logros ${ap.unlocked}/${ap.total}`;
  // el chip del tiempo cuenta una vida, no un contador: fecha y edad
  $('hud-month').textContent = s.dateLabel;
  const ageEl = $('hud-age');
  if (ageEl) ageEl.textContent = `${s.age} años`;

  // los tipos, a la vista: es lo que decide si tu hipoteca variable fue buena idea
  const rateEl = $('hud-rate');
  if (rateEl) {
    rateEl.textContent = `${s.rateDelta >= 0 ? '+' : ''}${s.rateDelta}%`;
    const chip = $('hud-rate-chip');
    if (chip) chip.dataset.tone = s.rateDelta > 8 ? 'bad' : s.rateDelta < -8 ? 'good' : 'flat';
  }

  // HUD compacto móvil
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('m-ie', `${s.ie}%`);
  set('m-cash', euro(s.cash));
  set('m-happy', s.happiness);
  set('m-energy', s.energy);
  set('m-month', `${s.age}a`);   // en móvil manda la edad: cabe y dice más
  set('m-actions', s.actionsLeft);

  // reevalúa las tarjetas del Marketplace con la caja actual (botones Contado/Hipoteca)
  if (market.length) renderMarket();
  renderPortfolio();
  renderStandings();
  renderP2P();
  renderWellbeing(s);
  renderLifestyle();
  renderGigs(s);
  renderVehicle(s);
  renderActivity();
  checkAchievements();

  // alquiler (solo en modos con extraRent)
  const rentRow = $('flow-rent-row');
  if (s.extraRent > 0) { rentRow.style.display = ''; $('flow-rent').textContent = '−' + euro(s.extraRent); }
  else rentRow.style.display = 'none';
  drawSparkline();
  refreshView();
  saveGame();
}

/* ---------------------- SEGUROS Y DISTRITOS ----------------------- */
/*
 * Dos caras de la misma moneda: los seguros quitan cola de pérdidas a cambio de
 * subir tu listón de libertad, y los distritos premian concentrar activos de la
 * misma categoría — que es lo que convierte la ciudad isométrica en decisión.
 */
function renderInsurance(s) {
  const wrap = $('insurance');
  if (!wrap || !DATA.insurance) return;
  wrap.innerHTML = engine.insurancePolicies().map(p => {
    const on = engine.hasInsurance(p.id);
    return `<button class="ins-btn ${on ? 'on' : ''}" data-ins="${p.id}" title="${p.lesson}">
        <span class="ins-em">${p.emoji}</span>
        <span class="ins-txt"><b>${p.label}</b><small>${p.desc}</small></span>
        <span class="ins-side">
          <b>${euro(p.monthly)}/mes</b>
          <small>cubre ${Math.round(p.coverage * 100)}%</small>
          <em>${on ? '✓ activa' : 'contratar'}</em>
        </span>
      </button>`;
  }).join('');
  const hint = $('ins-hint');
  hint.className = 'hint' + (s.insuranceCoverage ? ' good' : '');
  hint.innerHTML = s.insuranceCoverage
    ? `Tus pólizas absorben el <b>${s.insuranceCoverage}%</b> de cada imprevisto, y te cuestan
       <b>${euro(s.insuranceCost)}/mes</b> que suben tu listón de libertad.`
    : 'Sin seguros, cada imprevisto va entero contra tu caja. Protegerte cuesta libertad: ese es el trato.';
  wrap.querySelectorAll('button[data-ins]').forEach(b => {
    b.onclick = () => {
      const r = engine.toggleInsurance(b.dataset.ins);
      if (!r.ok) { toast('No se pudo', r.reason, 'bad'); return; }
      if (r.active) ach.bumpLife('policies');
      toast(`${r.policy.emoji} ${r.policy.label}`,
        r.active ? `Póliza contratada. ${r.policy.lesson}` : 'Póliza cancelada: vuelves a estar expuesto.',
        r.active ? 'good' : 'neutral');
      if (r.active) showTip('insurance');
      render();
    };
  });
}

const CAT_LABEL = { real_estate: '🏠 Inmuebles', digital_business: '💻 Negocios', financial: '📈 Financiero' };

function renderDistricts() {
  const wrap = $('districts');
  if (!wrap) return;
  wrap.innerHTML = Object.keys(CAT_LABEL).map(cat => {
    const d = engine.districtBonus(cat);
    const pct = d.next ? Math.min(100, d.n / d.next * 100) : 100;
    const bonus = d.tier
      ? `−${Math.round((1 - d.maint) * 100)}% mantenimiento${d.gross > 1 ? ` · +${Math.round((d.gross - 1) * 100)}% renta` : ''}`
      : 'sin bonus todavía';
    return `<div class="dist-row">
        <span class="dist-name">${CAT_LABEL[cat]} <b>${d.n}</b></span>
        <div class="dist-bar"><i class="t${d.tier}" style="width:${pct}%"></i></div>
        <span class="dist-bonus ${d.tier ? 'on' : ''}">${bonus}</span>
        ${d.next ? `<span class="dist-next">faltan ${d.next - d.n} para el siguiente nivel</span>` : '<span class="dist-next">nivel máximo</span>'}
      </div>`;
  }).join('');
}

/* --------------------------- FISCALIDAD --------------------------- */
/*
 * Los impuestos son la mitad del juego de las finanzas personales, así que
 * aquí se ven: base imponible, amortizaciones deducibles, tipo efectivo, y un
 * asesor que dice cuándo compensa subir de estructura — y cuándo NO, que es la
 * lección que más se salta la gente.
 */
function renderTax(s) {
  const adv = engine.taxAdvice();
  $('tax-vehicle').textContent = `${s.taxEmoji} ${s.taxLabel}`;
  $('tax-gross').textContent = euro(s.passiveIncome);
  $('tax-amort').textContent = '−' + euro(s.amortization);
  $('tax-base').textContent = euro(s.taxableBase);
  $('tax-cost').textContent = '−' + euro(s.taxCost);
  $('tax-rate').textContent = s.taxRate;

  // escalera: en qué peldaño estás y cuáles quedan
  const tier = engine.taxTier();
  $('tax-ladder').innerHTML = engine.taxStructures().map((st, i) => `
    <span class="tax-step ${i === tier ? 'on' : ''} ${i < tier ? 'past' : ''}"
          title="${st.label}: ${st.desc}">${st.emoji}<small>${st.short}</small></span>`).join('');

  const btn = $('btn-incorporate');
  const hint = $('tax-hint');
  if (!adv) { btn.style.display = 'none'; hint.textContent = ''; return; }
  btn.style.display = '';
  btn.disabled = false;
  const best = adv.best;
  btn.classList.toggle('hot', !!best);
  btn.textContent = best
    ? `${best.structure.emoji} Constituir ${best.structure.label} · ${euro(best.setup)}`
    : 'Ver estructuras fiscales';
  if (best) {
    hint.className = 'hint good';
    hint.innerHTML = `Tu asesor lo tiene claro: la <b>${best.structure.label}</b> te ahorraría
      <b>${euro(best.saving)}/mes</b>. Recuperas la constitución en ${best.payback} meses.`;
  } else if (adv.next && adv.next.blockedBy) {
    hint.className = 'hint';
    hint.innerHTML = `Siguiente peldaño: <b>${adv.next.structure.label}</b>. ${adv.next.blockedBy}.`;
  } else if (adv.next) {
    hint.className = 'hint';
    hint.innerHTML = `La <b>${adv.next.structure.label}</b> aún no compensa: sus costes fijos
      se comerían el ahorro. Crece primero.`;
  } else {
    hint.className = 'hint good';
    hint.textContent = '✓ Estás en la estructura más eficiente que existe.';
  }
}

/** Modal del asesor: compara todas las estructuras con tu renta de hoy. */
function showTaxAdvisor() {
  const adv = engine.taxAdvice();
  if (!adv) return;
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal tax-modal">
      <h2>🧾 Tu asesor fiscal</h2>
      <p class="lead">Todo esto es optimización <b>legal</b>: cada estructura existe, tiene su
        coste de constitución y de mantenimiento, y solo compensa a partir de cierta renta.
        Con tu base imponible de <b>${euro(engine.taxableBase())}/mes</b>, así queda hoy:</p>
      <div class="tax-list">
        ${adv.options.map(o => {
          const st = o.structure;
          const state = o.isCurrent ? 'current' : o.eligible ? (o.saving > 0 ? 'better' : 'worse') : 'locked';
          const badge = o.isCurrent ? '<span class="tx-b now">Tu estructura</span>'
            : !o.eligible ? `<span class="tx-b lock">🔒 ${o.blockedBy}</span>`
            : o.saving > 0 ? `<span class="tx-b good">Ahorras ${euro(o.saving)}/mes</span>`
            : `<span class="tx-b bad">Te costaría ${euro(-o.saving)}/mes más</span>`;
          const canDo = engine.canAdoptTax(st.id);
          return `
          <div class="tax-opt ${state}">
            <div class="tx-head">
              <span class="tx-em">${st.emoji}</span>
              <div class="tx-title"><b>${st.label}</b>${badge}</div>
            </div>
            <div class="tx-desc">${st.desc}</div>
            <div class="tx-lesson">💡 ${st.lesson}</div>
            <div class="tx-nums">
              <span>Impuestos<b>${euro(o.monthlyCost)}/mes</b></span>
              <span>Constitución<b>${o.setup ? euro(o.setup) : '—'}</b></span>
              <span>Recuperas en<b>${o.payback != null ? `${o.payback} meses` : '—'}</b></span>
            </div>
            ${o.isCurrent ? '' : `<button class="btn-lever btn-sm tx-go" data-tax="${st.id}"
              ${canDo.ok ? '' : 'disabled'} title="${canDo.ok ? 'Constituir' : canDo.reason}">
              ${canDo.ok ? `Constituir · ${euro(o.setup)}` : canDo.reason}</button>`}
          </div>`;
        }).join('')}
      </div>
      <button class="btn-primary" id="tax-close" style="width:100%;margin-top:14px">Cerrar</button>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#tax-close').onclick = () => ov.remove();
  ov.querySelectorAll('button[data-tax]').forEach(b => {
    b.onclick = () => {
      const r = engine.adoptTax(b.dataset.tax);
      if (!r.ok) { toast('No se pudo constituir', r.reason, 'bad'); return; }
      ov.remove();
      ach.bumpLife('incorporations');
      ach.bumpLife(`tax_${r.structure.id}`);
      toast(`${r.structure.emoji} ${r.structure.label}`,
        `Constituida por ${euro(r.cost)}. ${r.structure.lesson}`, 'good');
      logActivity(`${r.structure.emoji} Constituyes: ${r.structure.label}`, 'good');
      showTip('tax_ladder');
      render();
    };
  });
}

/* ------------------------ CICLO ECONÓMICO ------------------------- */
/*
 * La fase del ciclo es información pública y accionable: el panel dice qué
 * está pasando y qué conviene hacer, para que "comprar barato" deje de ser
 * suerte y pase a ser una decisión.
 */
function renderCycle(s) {
  const panel = $('panel-cycle');
  if (!panel) return;
  const c = s.cycle;
  panel.dataset.tone = c.tone;
  $('cyc-em').textContent = c.emoji;
  $('cyc-label').textContent = c.label;
  $('cyc-left').textContent = s.cycleLeft === 1 ? 'último mes' : `~${s.cycleLeft} meses`;
  $('cyc-desc').textContent = c.desc;
  const pct = (v) => `${v >= 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`;
  const cls = (v, good = true) => (v === 1 ? '' : (v > 1) === good ? 'up' : 'down');
  $('cyc-mods').innerHTML = `
    <span class="${cls(c.price, false)}">Precios <b>${pct(c.price)}</b></span>
    <span class="${cls(c.yield)}">Rentas <b>${pct(c.yield)}</b></span>
    <span class="${cls(c.risk, false)}">Riesgo <b>${pct(c.risk)}</b></span>`;
}

/* ---------------------------- LOGROS ------------------------------ */
/*
 * Los logros son lo único que sobrevive a la partida: dan una razón para
 * volver a jugar y objetivos a corto plazo entre medias del objetivo grande.
 */

/** Valores de cartera que las reglas necesitan y no están en status(). */
function achDerived() {
  const owned = engine.ownedAssets;
  const byCat = {};
  owned.forEach(a => { byCat[a.category] = (byCat[a.category] || 0) + 1; });
  const vols = owned.map(a => engine.yieldSpread(a));
  const avgVol = vols.length ? vols.reduce((s, v) => s + v, 0) / vols.length : 0;
  return {
    categories_owned: Object.keys(byCat).length,
    max_category_count: Math.max(0, ...Object.values(byCat)),
    leveraged_count: owned.filter(a => a.financing === 'leverage').length,
    low_vol_portfolio: owned.length >= 6 && avgVol < 0.20,
    high_vol_count: vols.filter(v => v > 0.40).length,
    all_assets_above_avg: owned.length >= 3 && owned.every(a => (a.yieldFactor ?? 1) > 1),
    tax_savings: Math.max(0, Math.round(
      engine.taxVehicle === 'company'
        ? Math.max(0, engine.totalPassiveIncome() - engine.TAX_THRESHOLD) * engine.PERSONAL_TAX - engine.COMPANY_MONTHLY
        : 0)),
    red_loans: ach.run.red_loans || 0,
    policies_active: engine.insurance.size,
    financial_count: byCat.financial || 0,
  };
}

/** Evalúa los logros y celebra los que se desbloqueen. */
function checkAchievements() {
  if (!ach || !engine) return;
  const fresh = ach.evaluate(engine.status(), achDerived());
  fresh.forEach((def, i) => {
    logActivity(`${def.emoji} Logro desbloqueado: ${def.title}`, 'good');
    if (!AUTO_MODE) setTimeout(() => { sfx.play('achievement'); showAchievement(def); }, 600 + i * 2600);
  });
}

/** Tarjeta de celebración cuando cae un logro. */
function showAchievement(def) {
  const tier = ach.tiers[def.tier] || {};
  const el = document.createElement('div');
  el.className = 'ach-pop';
  el.style.setProperty('--tier', tier.color || 'var(--green)');
  el.innerHTML = `
    <div class="ach-pop-em">${def.emoji}</div>
    <div class="ach-pop-txt">
      <div class="ach-pop-k">Logro · ${tier.label || ''} · +${ach.pointsOf(def)} pts</div>
      <div class="ach-pop-t">${def.title}</div>
      <div class="ach-pop-d">${def.desc}</div>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const close = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); };
  el.onclick = close;
  setTimeout(close, 5200);
}

/** Galería completa de logros, agrupada por categoría. */
function showAchievementsGallery() {
  const p = ach.progress();
  const groups = ach.byCategory();
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal ach-modal">
      <h2>🏅 Logros</h2>
      <p class="lead">Se conservan entre partidas: aunque pierdas, el progreso queda.</p>
      <div class="ach-summary">
        <div><span>Desbloqueados</span><b>${p.unlocked} <small>de ${p.total}</small></b></div>
        <div><span>Puntos</span><b>${p.points} <small>de ${p.maxPoints}</small></b></div>
      </div>
      <div class="ach-progress"><i style="width:${Math.round(p.unlocked / p.total * 100)}%"></i></div>
      ${groups.map(g => `
        <div class="ach-group">
          <h3>${g.emoji} ${g.label} <small>${g.done}/${g.list.length}</small></h3>
          <div class="ach-grid">
            ${g.list.map(d => {
              const on = ach.isUnlocked(d.id);
              const tier = ach.tiers[d.tier] || {};
              return `<div class="ach-item ${on ? 'on' : ''}" style="--tier:${tier.color || '#666'}"
                        title="${d.desc}">
                  <span class="ach-em">${on ? d.emoji : '🔒'}</span>
                  <span class="ach-txt">
                    <b>${d.title}</b>
                    <small>${d.desc}</small>
                  </span>
                  <span class="ach-pts">${ach.pointsOf(d)}</span>
                </div>`;
            }).join('')}
          </div>
        </div>`).join('')}
      <button class="btn-primary" id="ach-close" style="width:100%;margin-top:16px">Cerrar</button>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#ach-close').onclick = () => ov.remove();
}

/* ------------------------ ACCIONES DEL MES ------------------------ */
/*
 * El mes tiene un número de jugadas. Comprar, currar un extra, cuidarte o
 * refinanciar compiten por el mismo hueco: elegir qué NO haces es el juego.
 */
function renderActions(s) {
  const bar = $('actions-bar');
  if (!bar) return;
  $('ab-left').textContent = s.actionsLeft;
  $('ab-max').textContent = s.actionsMax;
  $('ab-pips').innerHTML = Array.from({ length: s.actionsMax }, (_, i) =>
    `<i class="${i < s.actionsLeft ? 'on' : ''}"></i>`).join('');
  bar.classList.toggle('empty', s.actionsLeft === 0);
  const hint = $('ab-hint');
  if (s.actionsLeft === 0) {
    hint.textContent = s.burnout
      ? 'Sin jugadas: el burnout te ha comido el mes. Pasa de mes y descansa.'
      : 'Has agotado el mes. Pasa de mes para recuperar tus jugadas.';
  } else if (s.burnout) {
    hint.textContent = '⚠️ El burnout te quita una acción al mes.';
  } else {
    hint.textContent = 'Comprar, un trabajo extra o cuidarte: cada jugada gasta una.';
  }

  // el avance rápido se ofrece de verdad cuando no hay nada que decidir; si hay
  // una oportunidad a tiro, sigue disponible pero avisa de que va a parar ya
  const ff = $('btn-fastforward');
  if (ff) {
    const idle = !hasPlayableOffer();
    ff.textContent = idle ? '⏩ Avanzar hasta que pase algo' : '⏩ Avanzar (hay una oportunidad a tiro)';
    ff.classList.toggle('idle', idle);
  }
}

/* ---------------------- VISTA (ciudad / global) ------------------- */
function refreshView() {
  if (!city) return;
  if (globalView) {
    const players = [
      { name: 'Tú', emoji: engine.profile.emoji, me: true, ie: engine.emancipationIndex(),
        count: engine.ownedAssets.length, won: engine.hasWon(), list: engine.ownedAssets },
      ...bots.map(b => ({ name: b.name, emoji: b.emoji, me: false, ie: b.engine.emancipationIndex(),
        count: b.engine.ownedAssets.length, won: b.engine.hasWon(), list: b.engine.ownedAssets })),
    ];
    city.setViewData(players, BUILDING_POOLS);
  } else {
    city.setViewData(null, null);
  }
  city.draw();
}

function toggleView() {
  globalView = !globalView;
  $('btn-view').querySelector('.chip-ic').textContent = globalView ? '🏙️' : '🌍';
  $('view-txt').textContent = globalView ? ' Mi ciudad' : ' Vista global';
  refreshView();
}

/* ---------------------- NAVEGACIÓN MÓVIL -------------------------- */
function setMobileTab(tab) {
  document.body.dataset.mtab = tab;
  document.querySelectorAll('#m-nav .m-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.mtab === tab));
  // el tamaño del contenedor de la ciudad cambia con la pestaña → recolocar
  if (city) requestAnimationFrame(() => { city.resize(); refreshView(); });
  // al entrar en una pestaña de paneles, sube el scroll al inicio
  if (tab !== 'city') window.scrollTo(0, 0);
}

function wireMobileNav() {
  document.querySelectorAll('#m-nav .m-tab').forEach(btn => {
    btn.onclick = () => setMobileTab(btn.dataset.mtab);
  });
  setMobileTab(document.body.dataset.mtab || 'market');
  // redibuja la ciudad al rotar/redimensionar
  window.addEventListener('resize', () => { if (city) { city.resize(); refreshView(); } });
}

/* ---------------------------- VEHÍCULO ---------------------------- */
function renderVehicle(s) {
  const wrap = $('veh-current');
  if (!wrap) return;
  const v = s.vehicle;
  wrap.innerHTML = v
    ? `<img src="${v.sprite}" class="veh-img" alt="">
       <div class="veh-info"><b>${v.emoji} ${v.label}</b><small>${euro(v.monthly)}/mes</small></div>`
    : `<span class="veh-emoji">🚶</span>
       <div class="veh-info"><b>Sin coche</b><small>Transporte público · ${euro(s.vehicleCost)}/mes</small></div>`;
}

function showVehicleChooser() {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal veh-modal">
      <h2>Elige tu vehículo</h2>
      <p class="lead">Un coche sube tu felicidad… pero es un <b>pasivo</b>: su coste mensual eleva tu
        listón de libertad (entra en el IE). Financiarlo genera <b style="color:var(--red)">deuda roja</b>.</p>
      <div class="veh-list">
        ${DATA.vehicles.map(v => {
          const active = (engine.vehicle && engine.vehicle.id === v.id) || (!engine.vehicle && v.id === 'none');
          const resale = engine.vehicleResaleValue();
          const acts = v.id === 'none'
            ? `<button class="btn-cash" data-veh="none" data-fin="cash" style="flex:1">${engine.vehicle ? `Vender coche (+${euro(resale)})` : 'Ir sin coche'}</button>`
            : active
              ? `<span class="veh-owned">✓ Tu coche actual</span>`
              : `<button class="btn-cash" data-veh="${v.id}" data-fin="cash" ${engine.cash + (engine.vehicle ? resale : 0) < v.price ? 'disabled' : ''}>Contado ${euro(v.price)}</button>
                 ${v.financeable ? `<button class="btn-lever" data-veh="${v.id}" data-fin="loan" ${engine.cash + (engine.vehicle ? resale : 0) < Math.round(v.price * 0.15) ? 'disabled' : ''}>Financiar</button>` : ''}`;
          return `<div class="veh-opt ${active ? 'active' : ''}">
              <div class="veh-opt-top">
                ${v.sprite ? `<img src="${v.sprite}" alt="">` : `<span class="veh-emoji">${v.emoji}</span>`}
                <div><b>${v.label}</b><div class="veh-desc">${v.desc}</div></div>
              </div>
              <div class="veh-nums">${v.price ? `Compra ${euro(v.price)} · ` : ''}${euro(v.monthly)}/mes${v.happiness ? ` · +${v.happiness}😊` : ''}</div>
              <div class="veh-actions">${acts}</div>
            </div>`;
        }).join('')}
      </div>
      <button class="btn-ghost" id="veh-close" style="width:100%;margin-top:12px">Cerrar</button>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#veh-close').onclick = () => ov.remove();
  ov.querySelectorAll('button[data-veh]').forEach(btn => {
    btn.onclick = () => {
      const v = DATA.vehicles.find(x => x.id === btn.dataset.veh);
      const r = engine.chooseVehicle(v, btn.dataset.fin);
      if (r.ok) {
        if (v.id !== 'none') ach.setRun('bought_car', true);
        if (btn.dataset.fin === 'loan') ach.bumpRun('red_loans');
        ov.remove();
        const soldMsg = r.proceeds ? `Vendido por ${euro(r.proceeds)}. ` : '';
        toast(`${v.emoji} ${v.label}`,
          v.id === 'none' ? `${soldMsg}Vuelves al transporte público.`
          : btn.dataset.fin === 'loan' ? `${soldMsg}Financiado: genera deuda roja que penaliza tu IE.`
          : `${soldMsg}Elección aplicada.`, 'good');
        logActivity(v.id === 'none' ? '🫵 Vendes el coche' : `🫵 Coche: ${v.label}`, 'neutral');
        if (btn.dataset.fin === 'loan') showTip('car_finance');
        render();
      } else toast('No se pudo', r.reason, 'bad');
    };
  });
}

/* ------------------------- BIENESTAR / VIDA ----------------------- */
function renderWellbeing(s) {
  const hp = $('wb-happy'), en = $('wb-energy');
  if (!hp) return;
  hp.style.width = s.happiness + '%';
  en.style.width = s.energy + '%';
  hp.className = s.happiness < 25 ? 'danger' : s.happiness < 50 ? 'warn' : '';
  en.className = s.energy < 25 ? 'danger' : s.energy < 40 ? 'warn' : '';
  $('wb-happy-v').textContent = s.happiness;
  $('wb-energy-v').textContent = s.energy;
  const hint = $('wb-hint');
  const notes = [];
  if (s.burnout) notes.push('⚠️ <b style="color:var(--red)">Burnout</b>: tu sueldo cae. ¡Descansa!');
  if (s.happiness < 25) notes.push('😟 Felicidad crítica: si llega a 0, abandonas.');
  if (s.salaryBoost > 0) notes.push(`📈 +${s.salaryBoost}% de sueldo por formación/ascensos.`);
  hint.innerHTML = notes.join('<br>');
  hint.className = 'hint' + (s.burnout || s.happiness < 25 ? '' : ' good');
}

function renderLifestyle() {
  const wrap = $('lifestyle');
  if (!wrap || !DATA.lifestyle) return;
  wrap.innerHTML = DATA.lifestyle.map(a => {
    const used = engine.lifestyleUsed.has(a.id);
    const afford = engine.cash >= a.cost;
    const fx = [];
    if (a.happiness) fx.push(`${a.happiness > 0 ? '+' : ''}${a.happiness}😊`);
    if (a.energy) fx.push(`${a.energy > 0 ? '+' : ''}${a.energy}⚡`);
    if (a.salaryBoost) fx.push(`+${Math.round(a.salaryBoost * 100)}%💼`);
    return `<button class="life-btn" data-life="${a.id}" ${used || !afford ? 'disabled' : ''}
        title="${a.desc}">
        <span class="life-em">${a.emoji}</span>
        <span class="life-txt"><b>${a.label}</b><small>${fx.join(' · ')}</small></span>
        <span class="life-cost">${a.cost ? euro(a.cost) : 'gratis'}${used ? ' ✓' : ''}</span>
      </button>`;
  }).join('');
  wrap.querySelectorAll('button[data-life]').forEach(btn => {
    btn.onclick = () => {
      const action = DATA.lifestyle.find(x => x.id === btn.dataset.life);
      const r = engine.doLifestyle(action);
      if (r.ok) {
        ach.bumpLife('lifestyle_actions');
        toast(`${action.emoji} ${action.label}`, action.desc, 'good');
        logActivity(`${action.emoji} ${action.label}`, 'good');
        render();
      } else toast('No disponible', r.reason, 'bad');
    };
  });
}

/* --------------------------- TRABAJOS EXTRA ----------------------- */
function renderGigs(s) {
  const panel = $('panel-gigs'), wrap = $('gigs');
  if (!panel || !wrap) return;
  if (!s.gigsEnabled) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  wrap.innerHTML = DATA.gigs.map(g => {
    const used = engine.gigsUsed.has(g.id);
    const fx = [];
    if (g.energy) fx.push(`${g.energy}⚡`);
    if (g.happiness) fx.push(`${g.happiness > 0 ? '+' : ''}${g.happiness}😊`);
    return `<button class="life-btn" data-gig="${g.id}" ${used ? 'disabled' : ''} title="${g.desc}">
        <span class="life-em">${g.emoji}</span>
        <span class="life-txt"><b>${g.label}</b><small>${fx.join(' · ')}</small></span>
        <span class="life-cost" style="color:var(--green)">+${euro(g.cash)}${used ? ' ✓' : ''}</span>
      </button>`;
  }).join('');
  wrap.querySelectorAll('button[data-gig]').forEach(btn => {
    btn.onclick = () => {
      const gig = DATA.gigs.find(x => x.id === btn.dataset.gig);
      const r = engine.doGig(gig);
      if (r.ok) {
        ach.bumpLife('gigs');
        toast(`${gig.emoji} ${gig.label}`, `Ganas ${euro(r.earned)} a cambio de energía.`, 'good');
        logActivity(`🫵 ${gig.label} (+${euro(r.earned)})`, 'good');
        render();
      } else toast('No disponible', r.reason, 'bad');
    };
  });
}

/* --------------------------- PERSISTENCIA ------------------------- */
function saveGame() {
  if (!engine || ended) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      engine: engine.toJSON(),
      bots: bots.map(b => ({ name: b.name, emoji: b.emoji, aggr: b.aggr,
        profileId: b.engine.profile.id, engine: b.engine.toJSON() })),
      market: market.map(m => ({ id: m.asset.id, left: m.left })),
      achRun: ach ? ach.run : {},
      rivalWinsSeen,
      ts: Date.now(),
    }));
  } catch (e) { /* almacenamiento no disponible */ }
}
function loadSave() {
  try { const raw = localStorage.getItem(SAVE_KEY); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}
function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* noop */ }
}

async function resumeGame(save) {
  const profile = DATA.profiles.find(x => x.id === save.engine.profileId) || DATA.profiles[0];
  engine = EconomyEngine.fromJSON(save.engine, profile, DATA.events);
  engine.setTaxData(DATA.tax);
  engine.setInsuranceData(DATA.insurance);
  engine.setContractData(DATA.contracts);
  buildCatalog();
  ended = false;
  rivalWinsSeen = [...(save.rivalWinsSeen || [])];   // no repreguntar por rivales ya avisados
  ach.newRun();
  ach.run = { ...(save.achRun || {}) };   // los contadores de esta partida siguen contando
  $('profile-overlay').style.display = 'none';
  $('hud-profile').innerHTML = chipHTML(profile.emoji, profile.short || profile.name);
  if (engine.mode) { $('hud-mode').innerHTML = chipHTML(engine.mode.emoji || '', engine.mode.label || ''); $('hud-mode').style.display = ''; }
  const prof = DATA.professions.find(pr => pr.id === engine.professionId);
  if (prof && prof.id !== 'none') { $('hud-prof').innerHTML = chipHTML(prof.emoji, prof.label); $('hud-prof').style.display = ''; }
  else $('hud-prof').style.display = 'none';

  bots = (save.bots || []).map(bs => ({
    name: bs.name, emoji: bs.emoji, aggr: bs.aggr,
    engine: Object.assign(
      EconomyEngine.fromJSON(bs.engine, DATA.profiles.find(x => x.id === bs.profileId) || DATA.profiles[0], DATA.events),
      { taxData: DATA.tax, insuranceData: DATA.insurance }),
  }));

  const canvas = $('city');
  city = new IsoCity(canvas, 6, 6);
  await city.loadSprites(spriteMap);
  city.setBuildingPools(BUILDING_POOLS);
  window.addEventListener('resize', () => city.resize());
  city.resize();
  city.buildDistricts();
  // re-colocar los edificios de los activos ya comprados (con su sprite guardado)
  engine.ownedAssets.forEach(a => {
    if (a.cell && city.grid[a.cell.row] && city.grid[a.cell.row][a.cell.col]) {
      city.grid[a.cell.row][a.cell.col].building = a.citySprite || city.pickBuildingSprite(a.category);
      city.grid[a.cell.row][a.cell.col].decor = null;
    }
  });
  city.draw();

  // el tablón se guarda con la vida que le queda a cada oportunidad
  market = (save.market || []).map(m => {
    const asset = catalog.find(a => a.id === (m.id ?? m));   // compat: guardados antiguos
    return asset ? { asset, left: m.left ?? MARKET_TTL[1] } : null;
  }).filter(Boolean);
  if (market.length) { fillMarket(); renderMarket(); } else refreshMarket();
  p2pOffers = [];
  render();
  maybeTutorial();
}

/* ------------------------ SPARKLINE DE IE ------------------------- */
function drawSparkline() {
  const cv = $('ie-spark');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 280, h = 52;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const hist = engine.history;
  const maxIE = Math.max(engine.winTargetIE(), ...hist.map(p => p.ie), 10);
  const x = i => hist.length > 1 ? (i / (hist.length - 1)) * (w - 4) + 2 : w / 2;
  const y = ie => h - 4 - (ie / maxIE) * (h - 8);

  // línea de meta 120%
  ctx.strokeStyle = 'rgba(255,178,62,.5)';
  ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y(engine.winTargetIE())); ctx.lineTo(w, y(engine.winTargetIE())); ctx.stroke();
  ctx.setLineDash([]);

  if (hist.length < 2) return;

  // relleno bajo la curva
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(46,230,160,.35)');
  grad.addColorStop(1, 'rgba(46,230,160,0)');
  ctx.beginPath();
  ctx.moveTo(x(0), y(hist[0].ie));
  hist.forEach((p, i) => ctx.lineTo(x(i), y(p.ie)));
  ctx.lineTo(x(hist.length - 1), h); ctx.lineTo(x(0), h); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // curva IE
  ctx.beginPath();
  hist.forEach((p, i) => i ? ctx.lineTo(x(i), y(p.ie)) : ctx.moveTo(x(i), y(p.ie)));
  ctx.strokeStyle = '#2ee6a0'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

  // punto final
  const last = hist[hist.length - 1];
  ctx.beginPath(); ctx.arc(x(hist.length - 1), y(last.ie), 3, 0, Math.PI * 2);
  ctx.fillStyle = '#2ee6a0'; ctx.fill();
}

/* ---------------------- TIPS EDUCATIVOS --------------------------- */
const TIP_KEY = 'freedomcash.tips.v1';
const TIPS = {
  first_asset: { t: '💡 Ingresos pasivos', d: 'Acabas de comprar tu primer activo. Su renta entra cada mes sin que trabajes: eso son ingresos pasivos, la base de la libertad financiera.' },
  leverage: { t: '💡 Apalancamiento (deuda buena)', d: 'Con hipoteca pagas solo la entrada y el propio activo cubre su cuota. Usar deuda para comprar algo que te da dinero es "deuda buena".' },
  red_debt: { t: '⚠️ Deuda roja (deuda mala)', d: 'Un préstamo de consumo resta liquidez cada mes y no te da nada a cambio. Penaliza tu IE. Úsalo solo si es imprescindible.' },
  car_finance: { t: '⚠️ Un coche es un pasivo', d: 'Financiar un coche crea deuda roja y su coste mensual sube tu listón de libertad. Un coche saca dinero de tu bolsillo: es un pasivo, no un activo.' },
  incorporate: { t: '💡 Optimización fiscal', d: 'Con rentas altas, una sociedad paga impuestos fijos en vez de un recargo. Estructurar bien tus inversiones protege tu flujo de caja.' },
  tax_ladder: { t: '💡 La escalera fiscal', d: 'Cada estructura tiene costes fijos, así que subir antes de tiempo te hace PERDER dinero. La regla es siempre la misma: solo compensa cuando el ahorro mensual supera el coste de mantenerla, y la constitución se recupera en un plazo razonable.' },
  amortization: { t: '💡 Amortizar sin pagar', d: 'Un inmueble te deja deducir cada año un 3% del valor de la construcción. Es un gasto que resta impuestos pero NO sale de tu bolsillo: por eso el ladrillo es tan eficiente fiscalmente.' },
  p2p_assume: { t: '💡 Traspaso: compras capital, no el inmueble', d: 'En un traspaso pagas solo el capital que el vendedor había puesto y te subrogas en su hipoteca: la deuda pasa a ser tuya. Por eso el precio parece bajo — el inmueble sigue costando lo que costaba.' },
  insurance: { t: '💡 El seguro no es una inversión', d: 'Un seguro nunca te hace ganar dinero: te quita la posibilidad de perderlo todo de golpe. Y como su cuota es un gasto fijo más, sube tu listón de libertad. Ese es el trato: pagas tranquilidad con tiempo.' },
  liquidity: { t: '💡 Liquidez: no todo se vende hoy', d: 'Un fondo se liquida en el acto; un local tarda meses en colocarse. Por eso una cartera solo de ladrillo puede ser rentable y aun así dejarte sin poder pagar un imprevisto. Tener algo líquido no es ser conservador: es poder aguantar.' },
  district: { t: '💡 Economías de escala', d: 'Concentrar activos de la misma categoría abarata su gestión: un mismo proveedor, un mismo contrato marco. A partir de 3 del mismo tipo baja tu mantenimiento; a partir de 5 y de 8, más. Especializarse tiene premio.' },
  scam: { t: '🚨 Si parece demasiado bueno…', d: 'Nadie regala un 9% mensual garantizado. Las señales estaban en la ficha: rentabilidad imposible, cero gastos declarados y ningún banco dispuesto a financiarlo. Analizar cuesta calderilla; caer cuesta el capital entero.' },
  cycle_buy: { t: '💡 Se compra en la recesión', d: 'Cuando todo el mundo tiene miedo, los precios caen y las entradas se abaratan. Si has guardado caja, es tu momento: el activo que compres barato mantendrá su hipoteca barata para siempre.' },
  cycle_sell: { t: '💡 Se vende en el pico', d: 'En la burbuja los activos valen más de lo que rinden. Vender ahora lo que compraste barato realiza la plusvalía… y te deja liquidez para la próxima recesión.' },
  yield_band: { t: '💡 Los retornos son horquillas', d: 'Ningún activo renta lo mismo todos los meses: cada uno oscila dentro de su horquilla. Cuanto más riesgo, más ancha la banda. Diversificar no sube la media… pero estabiliza tu IE.' },
};
function tipSeen(id) { try { return JSON.parse(localStorage.getItem(TIP_KEY) || '[]').includes(id); } catch (e) { return false; } }
function markTip(id) { try { const a = JSON.parse(localStorage.getItem(TIP_KEY) || '[]'); if (!a.includes(id)) { a.push(id); localStorage.setItem(TIP_KEY, JSON.stringify(a)); } } catch (e) {} }
function showTip(id) {
  if (quiet()) return;   // en avance rápido las tips se apilarían de golpe
  const tip = TIPS[id];
  if (!tip || tipSeen(id)) return;
  markTip(id);
  const el = document.createElement('div');
  el.className = 'tip-card';
  el.innerHTML = `<div class="tip-t">${tip.t}</div><div class="tip-d">${tip.d}</div><button class="btn-sm tip-x">Entendido</button>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const close = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); };
  el.querySelector('.tip-x').onclick = close;
  setTimeout(close, 15000);
}

/* ---------------------------- TOAST ------------------------------- */
let toastTimer = null;
function toast(title, desc, tone = 'neutral') {
  if (tone === 'good') sfx.playSoft('good');
  else if (tone === 'bad') sfx.playSoft('bad');
  const t = $('toast');
  $('toast-title').textContent = title;
  $('toast-desc').textContent = desc;
  t.className = 'event-toast show ' + tone;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'event-toast ' + tone; }, 4200);
}

/* ------------------------------ INIT ------------------------------ */
(async function init() {
  await loadData();
  renderProfiles();
  $('btn-endturn').onclick = endTurn;
  $('btn-fastforward').onclick = fastForward;
  $('hud-prof-chip').onclick = () => { if (engine) showRetrain(); };
  $('btn-help').onclick = () => startTutorial();
  $('btn-view').onclick = toggleView;
  $('btn-leaderboard').onclick = () => showLeaderboard();
  // el AudioContext solo puede nacer de un gesto real del usuario
  const unlockOnce = () => { sfx.unlock(); document.removeEventListener('pointerdown', unlockOnce); };
  document.addEventListener('pointerdown', unlockOnce);
  const soundIc = $('sound-ic');
  soundIc.textContent = sfx.enabled ? '🔊' : '🔇';
  $('btn-sound').onclick = () => { soundIc.textContent = sfx.toggle() ? '🔊' : '🔇'; };

  $('btn-ach').onclick = () => showAchievementsGallery();
  $('btn-ach-start').onclick = () => showAchievementsGallery();
  wireDebtButtons();
  wireMobileNav();

  // Arranque rápido para demos/test:  game.html?auto=corporate|freelance|investor
  const params = new URLSearchParams(location.search);
  const auto = params.get('auto');
  if (params.get('lb')) showLeaderboard(); // hook de test
  AUTO_MODE = !!auto;

  // hook de test: ?diff=investor abre el selector de dificultad
  if (params.get('diff')) { const p = DATA.profiles.find(x => x.id === params.get('diff')) || DATA.profiles[0]; chooseDifficulty(p, DATA.professions[0]); return; }
  // hook de test: ?profsel=investor abre el selector de profesión
  if (params.get('profsel')) { const p = DATA.profiles.find(x => x.id === params.get('profsel')) || DATA.profiles[0]; chooseProfession(p); return; }

  // hook de test: ?dbg=1 expone el estado interno para inspeccionarlo desde fuera
  if (params.get('dbg')) {
    window.__fc = {
      get engine() { return engine; }, get bots() { return bots; },
      get market() { return market; }, get p2p() { return p2pOffers; },
      rivalsEyeing, botsSnipeMarket, tickMarket, endTurn,
    };
  }

  // hook de test: ?mtab=life abre esa pestaña móvil (tras arrancar)
  if (params.get('mtab')) setTimeout(() => setMobileTab(params.get('mtab')), 400);

  // oferta de continuar partida guardada
  const save = loadSave();
  if (save && save.engine && !auto) {
    const p = DATA.profiles.find(x => x.id === save.engine.profileId);
    $('resume-slot').innerHTML = `
      <button class="btn-primary" id="btn-resume" style="margin-bottom:14px">
        ▸ Continuar partida — ${p ? p.emoji : ''} ${p ? p.name : ''} · Mes ${save.engine.month}</button>
      <div class="hint" style="margin-bottom:18px">o empieza una ficha nueva abajo (reemplaza la guardada)</div>`;
    $('btn-resume').onclick = () => resumeGame(save);
  }

  if (auto) {
    const p = DATA.profiles.find(x => x.id === auto) || DATA.profiles[0];
    const m = DATA.modes.find(x => x.id === params.get('mode')) || DATA.modes[0];
    const pr = DATA.professions.find(x => x.id === params.get('prof')) || DATA.professions[0];
    await startGame(p, m, pr);
    // hook de test: ?tut=N muestra el tutorial en el paso N
    const tut = params.get('tut');
    if (tut !== null) startTutorial(parseInt(tut, 10) || 0);
    // hook de test: ?dilemma=1 muestra un dilema de ejemplo
    if (params.get('dilemma')) {
      const dev = DATA.events.find(e => e.type === 'dilemma');
      if (dev) showDilemma(dev, () => {});
    }
    // hook de test: ?veh=1 abre el selector de vehículo
    if (params.get('veh')) showVehicleChooser();
    // hook de test: ?win=1 fuerza la victoria (para probar el Modo Legado)
    if (params.get('win')) {
      engine.cash = 5e7;
      let safety = 40;
      while (!engine.hasWon() && safety-- > 0) {
        engine.actionsUsed = 0;   // el hook de test ignora el presupuesto de acciones
        const best = catalog.filter(a => engine.assetEligible(a) && engine.canBuy(a, 'cash').ok)
          .sort((x, y) => y.financials.net_monthly_cashflow - x.financials.net_monthly_cashflow)[0];
        if (!best) break;
        engine.buyAsset(best, 'cash');
      }
      engine.actionsUsed = 0;
      engine.cash = 5e7;
      render(); checkEnd();
    }
    // hook de test: ?view=global abre la vista global
    if (params.get('view') === 'global') toggleView();
    // hook de test: ?tip=<id> muestra una tip (ignora AUTO_MODE)
    const tipId = params.get('tip');
    if (tipId && TIPS[tipId]) { const save = AUTO_MODE; AUTO_MODE = false; markTip('_'); showTip(tipId); AUTO_MODE = save; }
    if (params.get('demo')) {
      // compra oportunidades asequibles y pasa varios meses (solo test/demo)
      const turns = parseInt(params.get('demo'), 10) || 1;
      for (let t = 0; t < turns; t++) {
        market.slice().forEach(({ asset: a }) => {
          const fin = a.leverage_allowed && engine.canBuy(a, 'leverage').ok ? 'leverage'
                    : engine.canBuy(a, 'cash').ok ? 'cash' : null;
          if (fin) doBuy(a.id, fin);
        });
        // cuida el bienestar en la demo (si no, abandona)
        if (engine.energy < 40) { const r = DATA.lifestyle.find(l => l.id === 'rest'); if (r) engine.doLifestyle(r); }
        if (engine.happiness < 48) { const d = DATA.lifestyle.find(l => l.id === 'dinner'); if (d) engine.doLifestyle(d); }
        // compra un coche usado en la demo
        if (!engine.vehicle && engine.cash > 4500 + engine.fixedExpenses() * 3) {
          const used = DATA.vehicles.find(v => v.id === 'used'); if (used) engine.chooseVehicle(used, 'cash');
        }
        // ejercita fiscalidad y refinanciación en la demo
        if (engine.taxVehicle === 'personal' && engine.incorporationBenefit() > 0 &&
            engine.cash > engine.COMPANY_SETUP + engine.fixedExpenses() * 2) engine.incorporate();
        if (engine.mortgageModifier > 1.05) {
          const tg = engine.ownedAssets.find(a => a.financing === 'leverage' && !a.refinanced);
          if (tg && engine.canRefinance(tg.instanceId).ok) engine.refinanceAsset(tg.instanceId);
        }
        if (!ended) endTurn();
        // aprovecha una oferta P2P si la hay y hay liquidez (demo)
        if (p2pOffers.length && engine.cash > p2pOffers[0].price + engine.fixedExpenses()) buyP2P(0);
      }
    }
  }
})();
