/**
 * main.js — Controlador principal de Freedom Cash.
 * Une EconomyEngine (lógica) + IsoCity (render) + DOM (UI fintech).
 */
import { EconomyEngine, WIN_IE } from './engine/EconomyEngine.js';
import { IsoCity } from './engine/IsoCity.js';
import { takeBotTurn } from './engine/BotAI.js';
import { Tutorial } from './ui/tutorial.js';
import { computeScore, submitScore, topScores } from './engine/Leaderboard.js';

const $ = (id) => document.getElementById(id);
const euro = (n) => `${Math.round(n).toLocaleString('es-ES')} €`;
// chip con emoji (siempre visible) + texto (ocultable en móvil)
const chipHTML = (emoji, text) => `<span class="chip-ic">${emoji}</span><span class="chip-txt"> ${text}</span>`;
const shuffleArr = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
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
  { sel: '#panel-tax', title: 'Estrategia: fiscalidad y refi',
    text: 'Con renta pasiva alta, constituir una <b>sociedad</b> baja tus impuestos. Y desde tu portfolio puedes <b>refinanciar</b> hipotecas para reducir cuotas.' },
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
let market = [];            // oportunidades visibles este turno
let p2pOffers = [];         // activos que los rivales ponen a la venta
let p2pSeq = 0;             // contador de instancias compradas por P2P
let ended = false;          // evita disparar el fin de partida dos veces
let activityLog = [];       // feed de actividad (jugador + rivales)
let AUTO_MODE = false;      // demos/test: resuelve dilemas automáticamente
let globalView = false;     // alterna entre "mi ciudad" y "vista global"
const spriteMap = {};       // key -> url para IsoCity

/* ----------------------------- CARGA ------------------------------ */
async function loadData() {
  const [a, p, e, l, v, d, g, pr] = await Promise.all([
    fetch('src/data/assets_database.json').then(r => r.json()),
    fetch('src/data/profiles.json').then(r => r.json()),
    fetch('src/data/events.json').then(r => r.json()),
    fetch('src/data/lifestyle.json').then(r => r.json()),
    fetch('src/data/vehicles.json').then(r => r.json()),
    fetch('src/data/difficulty.json').then(r => r.json()),
    fetch('src/data/gigs.json').then(r => r.json()),
    fetch('src/data/professions.json').then(r => r.json()),
  ]);
  DATA.assets = a.assets;
  DATA.profiles = p.profiles;
  DATA.events = e.events;
  DATA.lifestyle = l.actions;
  DATA.vehicles = v.vehicles;
  DATA.modes = d.modes;
  DATA.gigs = g.gigs;
  DATA.professions = pr.professions;

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
  engine.professionId = profession.id;
  ended = false;
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
    be.professionId = profPool.length ? profPool[Math.floor(Math.random() * profPool.length)].id : 'none';
    return { name: rivalNames[i] || 'Rival', emoji: bp.emoji, engine: be, aggr: 0.5 + i * 0.15 };
  });

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

/* -------------------------- MARKETPLACE --------------------------- */
function affordable(a) {
  return engine.canBuy(a, 'cash').ok || (a.leverage_allowed && engine.canBuy(a, 'leverage').ok);
}

function refreshMarket() {
  // solo oportunidades elegibles (universales + de tu profesión)
  const pool = DATA.assets.filter(a => engine.assetEligible(a));
  market = [];
  while (market.length < 3 && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    market.push(pool.splice(i, 1)[0]);
  }
  // sesga: si tienes profesión, que a menudo aparezca uno de TUS proyectos
  const myProjects = pool.filter(a => a.profession === engine.professionId);
  if (engine.professionId !== 'none' && myProjects.length && !market.some(a => a.profession) && Math.random() < 0.6) {
    market[Math.floor(Math.random() * market.length)] = myProjects[Math.floor(Math.random() * myProjects.length)];
  }
  // garantiza al menos una opción asequible para no bloquear el turno
  if (!market.some(affordable)) {
    const cheap = pool.filter(affordable).sort((a, b) =>
      engine.canBuy(a, 'leverage').cost - engine.canBuy(b, 'leverage').cost)[0];
    if (cheap) market[market.length - 1] = cheap;
  }
  renderMarket();
}

function renderMarket() {
  const wrap = $('market');
  wrap.innerHTML = '';
  market.forEach(a => {
    const f = a.financials;
    const cashCheck = engine.canBuy(a, 'cash');
    const levCheck = engine.canBuy(a, 'leverage');
    const catLabel = { real_estate: 'Inmueble', digital_business: 'Negocio', financial: 'Financiero' }[a.category];
    const prof = a.profession ? DATA.professions.find(pr => pr.id === a.profession) : null;
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
      <div class="desc">${a.description}</div>
      <div class="mini-grid">
        <span>Precio<b>${euro(f.total_price)}</b></span>
        <span>Cashflow<b style="color:var(--green)">+${euro(f.net_monthly_cashflow)}</b></span>
        <span>Entrada<b>${a.leverage_allowed ? euro(f.down_payment_required) : '—'}</b></span>
        <span>CoC<b>${a.metrics.coc_return_percentage}%</b></span>
      </div>
      <span style="font-size:11px;color:var(--txt-dim)">Riesgo de vacancia/volatilidad</span>
      <div class="risk"><i style="width:${Math.round(a.metrics.vacancy_rate_risk*100)}%"></i></div>
      <div class="buy-row">
        <button class="btn-cash" ${cashCheck.ok ? '' : 'disabled'} data-buy="cash" data-id="${a.id}">
          Contado</button>
        <button class="btn-lever" ${(a.leverage_allowed && levCheck.ok) ? '' : 'disabled'} data-buy="leverage" data-id="${a.id}">
          ${a.leverage_allowed ? 'Hipoteca' : 'Sin deuda'}</button>
      </div>`;
    wrap.appendChild(el);
  });

  wrap.querySelectorAll('button[data-buy]').forEach(btn => {
    btn.onclick = () => doBuy(btn.dataset.id, btn.dataset.buy);
  });
}

function doBuy(assetId, financing) {
  const asset = DATA.assets.find(a => a.id === assetId);
  const res = engine.buyAsset(asset, financing);
  if (!res.ok) { toast('No se pudo comprar', res.reason, 'bad'); return; }

  // aparece el edificio en su distrito (sprite variado; guardamos celda y sprite)
  const placed = city.placeBuilding(asset.category);
  if (placed) { res.instance.cell = placed.cell; res.instance.citySprite = placed.key; city.emitCoins(); }

  // reemplaza la tarjeta comprada por otra nueva del pool
  const idx = market.findIndex(m => m.id === assetId);
  const remaining = DATA.assets.filter(a => engine.assetEligible(a) && !market.includes(a));
  if (remaining.length) market[idx] = remaining[Math.floor(Math.random() * remaining.length)];
  else market.splice(idx, 1);

  toast('✅ Activo adquirido',
    `${asset.title} · ${financing === 'leverage' ? 'financiado con hipoteca (deuda verde)' : 'pagado al contado'}`,
    'good');
  logActivity(`🫵 Compraste ${asset.title}`, 'good');
  if (engine.ownedAssets.length === 1) showTip('first_asset');
  if (financing === 'leverage') showTip('leverage');
  renderMarket();
  render();
}

/* -------------------------- PORTFOLIO ----------------------------- */
function renderPortfolio() {
  const wrap = $('portfolio');
  if (!engine.ownedAssets.length) {
    wrap.innerHTML = '<div class="empty">Aún no tienes activos. Compra en el Marketplace.</div>';
    return;
  }
  wrap.innerHTML = '';
  engine.ownedAssets.forEach(a => {
    const cf = engine.assetNetIncome(a);
    let badge = a.financing === 'leverage'
      ? '<span class="badge green">VERDE</span>' : '<span class="badge cash">CONTADO</span>';
    if (a.refinanced) badge += '<span class="badge refi">REFI</span>';
    // botón de refinanciar solo en hipotecas no refinanciadas
    const canRefi = a.financing === 'leverage' && !a.refinanced;
    const refiBtn = canRefi
      ? `<button class="btn-ghost btn-sm" data-refi="${a.instanceId}" title="Baja la cuota un 25% y fija el tipo · comisión ${euro(engine.refiFee(a))}">Refi</button>`
      : '';
    const el = document.createElement('div');
    el.className = 'pf-item';
    el.innerHTML = `
      <img src="${a.sprite}" alt="">
      <div class="pf-t">${a.title} ${badge}</div>
      <div class="pf-cf" style="color:${cf >= 0 ? 'var(--green)' : 'var(--red)'}">
        ${cf >= 0 ? '+' : ''}${euro(cf)}</div>
      <div class="pf-actions">
        ${refiBtn}
        <button class="btn-ghost btn-sm" data-sell="${a.instanceId}">Vender</button>
      </div>`;
    wrap.appendChild(el);
  });
  wrap.querySelectorAll('button[data-refi]').forEach(btn => {
    btn.onclick = () => {
      const r = engine.refinanceAsset(btn.dataset.refi);
      if (r.ok) { toast('🔧 Hipoteca refinanciada', `Comisión ${euro(r.fee)}. Cuota −25% y tipo fijado (inmune a subidas).`, 'good'); render(); }
      else toast('No se pudo refinanciar', r.reason, 'bad');
    };
  });
  wrap.querySelectorAll('button[data-sell]').forEach(btn => {
    btn.onclick = () => {
      const inst = engine.ownedAssets.find(a => a.instanceId === btn.dataset.sell);
      const cell = inst && inst.cell;
      const r = engine.sellAsset(btn.dataset.sell);
      if (r.ok) {
        if (cell) city.removeBuilding(cell);
        toast('Activo vendido', `Recuperas ${euro(r.proceeds)} de capital.`, 'good');
        render();
      }
    };
  });
}

/* ---------------------------- TURNO ------------------------------- */
function endTurn() {
  if (ended) return;
  // el evento del jugador se elige ANTES: si es un dilema, hay que decidir
  const ev = engine.pickEvent();
  if (engine.isDilemma(ev)) {
    if (AUTO_MODE) resolveTurn(ev, engine.autoDilemmaChoice(ev));
    else showDilemma(ev, (choiceIndex) => resolveTurn(ev, choiceIndex));
  } else {
    resolveTurn(ev, null);
  }
}

function resolveTurn(ev, choiceIndex) {
  const snap = engine.endTurn(ev, choiceIndex);
  const tone = ev ? ev.tone : 'neutral';
  let desc = ev ? ev.description : '';
  if (snap.adj && snap.adj._vacancyAsset) desc += ` (${snap.adj._vacancyAsset})`;
  if (snap.adj && snap.adj._choice) desc += ` → ${snap.adj._choice}`;

  city.emitCoins();
  $('hud-month').textContent = engine.month;

  const sign = snap.cashflow >= 0 ? '+' : '';
  toast(`📅 Mes ${engine.month - 1} · ${ev ? ev.title : 'Liquidación'}`,
    `${desc}  ·  Cashflow del mes: ${sign}${euro(snap.cashflow)}`, tone);
  if (ev && ev.title) logActivity(`📅 ${ev.title}`, tone);

  // turno de los oponentes IA (compran, se cuidan y resuelven sus eventos)
  bots.forEach(b => {
    const bought = takeBotTurn(b.engine, DATA.assets, DATA.lifestyle, DATA.vehicles, b.aggr, DATA.gigs) || [];
    b.engine.endTurn();
    bought.forEach(t => logActivity(`${b.emoji} ${b.name} compró ${t}`, 'neutral'));
    if (b.engine.hasLost()) logActivity(`${b.emoji} ${b.name} abandonó la partida 💥`, 'bad');
  });

  refreshMarket();
  refreshP2P();
  render();
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
function refreshP2P() {
  p2pOffers = [];
  bots.forEach(b => {
    const owned = b.engine.ownedAssets;
    if (owned.length < 2 || Math.random() > 0.3) return;
    const a = owned[Math.floor(Math.random() * owned.length)];
    const equity = a.financing === 'leverage' ? a.financials.down_payment_required : a.financials.total_price;
    const urgent = b.engine.cash < b.engine.fixedExpenses();  // necesita liquidez → descuento
    const price = Math.round(equity * (urgent ? 0.82 : 0.92));
    p2pOffers.push({ bot: b, instanceId: a.instanceId, asset: a, financing: a.financing, price, urgent });
  });
}

function buyP2P(idx) {
  const o = p2pOffers[idx];
  if (!o) return;
  if (engine.cash < o.price) { toast('Sin liquidez', `Necesitas ${euro(o.price)} para cerrar este trato.`, 'bad'); return; }

  // pago y transferencia del activo del bot al jugador
  engine.cash -= o.price;
  o.bot.engine.cash += o.price;
  o.bot.engine.ownedAssets = o.bot.engine.ownedAssets.filter(x => x.instanceId !== o.instanceId);

  const inst = { ...o.asset, financing: o.financing, instanceId: `${o.asset.id}#p2p${++p2pSeq}`, purchasedMonth: engine.month };
  delete inst.cell; delete inst.citySprite;
  engine.ownedAssets.push(inst);
  const placed = city.placeBuilding(o.asset.category);
  if (placed) { inst.cell = placed.cell; inst.citySprite = placed.key; city.emitCoins(); }

  p2pOffers.splice(idx, 1);
  toast('🤝 Trato P2P cerrado',
    `Compraste "${o.asset.title}" a ${o.bot.emoji} ${o.bot.name} por ${euro(o.price)}${o.urgent ? ' (venta forzada por liquidez)' : ''}.`, 'good');
  render();
}

function renderP2P() {
  const panel = $('p2p-panel');
  const wrap = $('p2p');
  if (!p2pOffers.length) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  wrap.innerHTML = p2pOffers.map((o, i) => `
    <div class="p2p-offer ${o.urgent ? 'urgent' : ''}">
      <img src="${o.asset.sprite}" alt="">
      <div class="p2p-info">
        <div class="p2p-title">${o.asset.title}</div>
        <div class="p2p-meta">${o.bot.emoji} ${o.bot.name} ${o.urgent ? '· <b style="color:var(--red)">liquidez urgente</b>' : '· reequilibra cartera'}</div>
        <div class="p2p-nums">Precio <b>${euro(o.price)}</b> · <span style="color:var(--green)">+${euro(o.asset.financials.net_monthly_cashflow)}/mes</span></div>
      </div>
      <button class="btn-lever btn-sm" data-p2p="${i}">Comprar</button>
    </div>`).join('');
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
      <div class="rk-bar"><i style="width:${Math.min(100, r.ie / WIN_IE * 100)}%"></i></div>
      <span class="rk-ie">${r.ie.toFixed(0)}%</span>
    </div>`).join('');
}

function checkEnd() {
  if (ended) return;
  const s = engine.status();
  if (s.won) {
    ended = true;
    endModal('🏆 ¡Libertad alcanzada!',
      `Has llegado a un Indicador de Emancipación del <b>${s.ie}%</b> con
       ${s.cushionMonths} meses de colchón. Tus activos pagan tu vida. Eres libre.`, true);
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
  const botWinner = bots.find(b => b.engine.hasWon());
  if (botWinner) {
    ended = true;
    endModal(`🤖 ${botWinner.name} llegó primero`,
      `Tu rival <b>${botWinner.emoji} ${botWinner.name}</b> alcanzó la libertad financiera antes que tú.
       Afina tu estrategia de apalancamiento y diversificación para la próxima.`, false);
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

function endModal(title, html, win) {
  clearSave();
  const st = computeEndStats();
  const rankTxt = ['🥇 1º', '🥈 2º', '🥉 3º'][st.rank - 1] || `${st.rank}º`;
  const s = engine.status();

  // puntúa y envía a la liga (clasificación persistente)
  const score = computeScore({
    won: win, months: st.months, netWorth: st.netWorth, ie: st.ie,
    happiness: s.happiness, energy: s.energy, rank: st.rank, profileId: engine.profile.id,
    scoreMult: engine.mode.scoreMult,
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
      <div class="end-actions">
        <button class="btn-ghost" id="btn-lb">🏆 Ver clasificación</button>
        <button class="btn-primary" id="btn-again" style="flex:1">Jugar otra vez</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#btn-again').onclick = () => { clearSave(); location.href = location.pathname; };
  ov.querySelector('#btn-lb').onclick = () => showLeaderboard();
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
  $('btn-incorporate').onclick = () => {
    const r = engine.incorporate();
    if (r.ok) { toast('🏢 Sociedad constituida', 'A partir de ahora tributas como sociedad: impuestos fijos en lugar de recargo por renta alta.', 'good'); showTip('incorporate'); render(); }
    else toast('No se pudo constituir', r.reason, 'bad');
  };
  $('btn-vehicle').onclick = showVehicleChooser;
}

/* ---------------------------- RENDER ------------------------------ */
function render() {
  const s = engine.status();
  const salary = engine.effectiveSalaryBase();

  // Barra de libertad
  $('ie-value').textContent = `${s.ie}%`;
  const pct = Math.min(100, (s.ie / WIN_IE) * 100);
  $('ie-bar').style.width = pct + '%';

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

  // Régimen fiscal
  $('tax-vehicle').textContent = s.taxVehicle === 'company' ? '🏢 Sociedad' : '👤 Persona física';
  $('tax-cost').textContent = '−' + euro(s.taxCost);
  const incBtn = $('btn-incorporate');
  const hint = $('tax-hint');
  if (s.taxVehicle === 'company') {
    incBtn.style.display = 'none';
    hint.className = 'hint good';
    hint.textContent = '✓ Estructura optimizada. Impuestos fijos de sociedad.';
  } else {
    incBtn.style.display = '';
    const benefit = Math.round(engine.incorporationBenefit());
    const affordable = engine.cash >= engine.COMPANY_SETUP;
    incBtn.disabled = !affordable;
    incBtn.classList.toggle('hot', benefit > 0 && affordable);
    hint.className = 'hint' + (benefit > 0 ? ' good' : '');
    hint.textContent = benefit > 0
      ? `Como sociedad ahorrarías ~${euro(benefit)}/mes en impuestos.`
      : 'Con renta pasiva alta, la sociedad reduce impuestos. Aún no compensa.';
  }
  const netEl = $('flow-net');
  netEl.textContent = (cf >= 0 ? '+' : '−') + euro(Math.abs(cf));
  netEl.className = 'val ' + (cf >= 0 ? 'green' : 'red');

  // Deuda verde/roja
  const totalDebt = s.greenDebt + s.redDebt || 1;
  $('db-green').style.width = (s.greenDebt / totalDebt * 100) + '%';
  $('db-red').style.width = (s.redDebt / totalDebt * 100) + '%';
  $('green-lbl').textContent = euro(s.greenDebt) + '/mes';
  $('red-lbl').textContent = euro(s.redDebt) + '/mes';

  // HUD (desktop chips)
  $('hud-assets').textContent = s.assetsCount;
  $('hud-month').textContent = s.month;

  // HUD compacto móvil
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('m-ie', `${s.ie}%`);
  set('m-cash', euro(s.cash));
  set('m-happy', s.happiness);
  set('m-energy', s.energy);
  set('m-month', s.month);

  renderPortfolio();
  renderStandings();
  renderP2P();
  renderWellbeing(s);
  renderLifestyle();
  renderGigs(s);
  renderVehicle(s);
  renderActivity();

  // alquiler (solo en modos con extraRent)
  const rentRow = $('flow-rent-row');
  if (s.extraRent > 0) { rentRow.style.display = ''; $('flow-rent').textContent = '−' + euro(s.extraRent); }
  else rentRow.style.display = 'none';
  drawSparkline();
  refreshView();
  saveGame();
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
      market: market.map(a => a.id),
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
  ended = false;
  $('profile-overlay').style.display = 'none';
  $('hud-profile').innerHTML = chipHTML(profile.emoji, profile.short || profile.name);
  if (engine.mode) { $('hud-mode').innerHTML = chipHTML(engine.mode.emoji || '', engine.mode.label || ''); $('hud-mode').style.display = ''; }
  const prof = DATA.professions.find(pr => pr.id === engine.professionId);
  if (prof && prof.id !== 'none') { $('hud-prof').innerHTML = chipHTML(prof.emoji, prof.label); $('hud-prof').style.display = ''; }
  else $('hud-prof').style.display = 'none';

  bots = (save.bots || []).map(bs => ({
    name: bs.name, emoji: bs.emoji, aggr: bs.aggr,
    engine: EconomyEngine.fromJSON(bs.engine, DATA.profiles.find(x => x.id === bs.profileId) || DATA.profiles[0], DATA.events),
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

  market = (save.market || []).map(id => DATA.assets.find(a => a.id === id)).filter(Boolean);
  if (market.length) renderMarket(); else refreshMarket();
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
  const maxIE = Math.max(WIN_IE, ...hist.map(p => p.ie), 10);
  const x = i => hist.length > 1 ? (i / (hist.length - 1)) * (w - 4) + 2 : w / 2;
  const y = ie => h - 4 - (ie / maxIE) * (h - 8);

  // línea de meta 120%
  ctx.strokeStyle = 'rgba(255,178,62,.5)';
  ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y(WIN_IE)); ctx.lineTo(w, y(WIN_IE)); ctx.stroke();
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
};
function tipSeen(id) { try { return JSON.parse(localStorage.getItem(TIP_KEY) || '[]').includes(id); } catch (e) { return false; } }
function markTip(id) { try { const a = JSON.parse(localStorage.getItem(TIP_KEY) || '[]'); if (!a.includes(id)) { a.push(id); localStorage.setItem(TIP_KEY, JSON.stringify(a)); } } catch (e) {} }
function showTip(id) {
  if (AUTO_MODE) return;
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
  $('btn-help').onclick = () => startTutorial();
  $('btn-view').onclick = toggleView;
  $('btn-leaderboard').onclick = () => showLeaderboard();
  wireDebtButtons();
  wireMobileNav();

  // Arranque rápido para demos/test:  index.html?auto=corporate|freelance|investor
  const params = new URLSearchParams(location.search);
  const auto = params.get('auto');
  if (params.get('lb')) showLeaderboard(); // hook de test
  AUTO_MODE = !!auto;

  // hook de test: ?diff=investor abre el selector de dificultad
  if (params.get('diff')) { const p = DATA.profiles.find(x => x.id === params.get('diff')) || DATA.profiles[0]; chooseDifficulty(p, DATA.professions[0]); return; }
  // hook de test: ?profsel=investor abre el selector de profesión
  if (params.get('profsel')) { const p = DATA.profiles.find(x => x.id === params.get('profsel')) || DATA.profiles[0]; chooseProfession(p); return; }

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
    // hook de test: ?view=global abre la vista global
    if (params.get('view') === 'global') toggleView();
    // hook de test: ?tip=<id> muestra una tip (ignora AUTO_MODE)
    const tipId = params.get('tip');
    if (tipId && TIPS[tipId]) { const save = AUTO_MODE; AUTO_MODE = false; markTip('_'); showTip(tipId); AUTO_MODE = save; }
    if (params.get('demo')) {
      // compra oportunidades asequibles y pasa varios meses (solo test/demo)
      const turns = parseInt(params.get('demo'), 10) || 1;
      for (let t = 0; t < turns; t++) {
        market.slice().forEach(a => {
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
