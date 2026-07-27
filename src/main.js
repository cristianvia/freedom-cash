/**
 * main.js — Controlador principal de Freedom Cash.
 * Une EconomyEngine (lógica) + IsoCity (render) + DOM (UI fintech).
 */
import { EconomyEngine, WIN_IE } from './engine/EconomyEngine.js';
import { IsoCity } from './engine/IsoCity.js';
import { takeBotTurn } from './engine/BotAI.js';

const $ = (id) => document.getElementById(id);
const euro = (n) => `${Math.round(n).toLocaleString('es-ES')} €`;

let engine = null;
let city = null;
let bots = [];              // oponentes IA: { name, emoji, engine, aggr }
let DATA = { assets: [], profiles: [], events: [] };
let market = [];            // oportunidades visibles este turno
let ended = false;          // evita disparar el fin de partida dos veces
const spriteMap = {};       // key -> url para IsoCity

/* ----------------------------- CARGA ------------------------------ */
async function loadData() {
  const [a, p, e] = await Promise.all([
    fetch('src/data/assets_database.json').then(r => r.json()),
    fetch('src/data/profiles.json').then(r => r.json()),
    fetch('src/data/events.json').then(r => r.json()),
  ]);
  DATA.assets = a.assets;
  DATA.profiles = p.profiles;
  DATA.events = e.events;

  // sprites de suelo/decoración + todos los edificios del catálogo
  Object.assign(spriteMap, {
    t_ground: 'assets/sprites/t_ground.png',
    t_grass: 'assets/sprites/t_grass.png',
    t_plaza: 'assets/sprites/t_plaza.png',
    t_tree: 'assets/sprites/t_tree.png',
    t_water: 'assets/sprites/t_water.png',
    t_road: 'assets/sprites/t_road.png',
  });
  DATA.assets.forEach(as => { spriteMap[as.id] = as.sprite; });
}

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
    el.onclick = () => startGame(p);
    wrap.appendChild(el);
  });
}

/* ---------------------------- ARRANQUE ---------------------------- */
async function startGame(profile) {
  engine = new EconomyEngine(profile, DATA.events);
  ended = false;
  $('profile-overlay').style.display = 'none';
  $('hud-profile').textContent = profile.emoji + ' ' + profile.name.split(' ')[0];

  // oponentes IA: los otros perfiles disponibles
  const others = DATA.profiles.filter(p => p.id !== profile.id);
  bots = others.map((bp, i) => ({
    name: bp.name.split(' ')[0],
    emoji: bp.emoji,
    engine: new EconomyEngine(bp, DATA.events),
    aggr: 0.5 + i * 0.15,
  }));

  // ciudad con distritos
  const canvas = $('city');
  city = new IsoCity(canvas, 6, 6);
  await city.loadSprites(spriteMap);
  window.addEventListener('resize', () => city.resize());
  city.resize();
  city.buildDistricts();

  refreshMarket();
  render();
}

/* -------------------------- MARKETPLACE --------------------------- */
function affordable(a) {
  return engine.canBuy(a, 'cash').ok || (a.leverage_allowed && engine.canBuy(a, 'leverage').ok);
}

function refreshMarket() {
  // muestra 3 oportunidades aleatorias no compradas aún (permitimos repetir tipos)
  const pool = [...DATA.assets];
  market = [];
  while (market.length < 3 && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    market.push(pool.splice(i, 1)[0]);
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
    const el = document.createElement('div');
    el.className = 'market-card';
    el.innerHTML = `
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

  // aparece el edificio en su distrito (guardamos la celda para poder retirarlo al vender)
  const cell = city.placeBuilding(assetId, asset.category);
  if (cell) { res.instance.cell = cell; city.emitCoins(); }

  // reemplaza la tarjeta comprada por otra nueva del pool
  const idx = market.findIndex(m => m.id === assetId);
  const remaining = DATA.assets.filter(a => !market.includes(a));
  if (remaining.length) market[idx] = remaining[Math.floor(Math.random() * remaining.length)];
  else market.splice(idx, 1);

  toast('✅ Activo adquirido',
    `${asset.title} · ${financing === 'leverage' ? 'financiado con hipoteca (deuda verde)' : 'pagado al contado'}`,
    'good');
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
    const badge = a.financing === 'leverage'
      ? '<span class="badge green">VERDE</span>' : '<span class="badge cash">CONTADO</span>';
    const el = document.createElement('div');
    el.className = 'pf-item';
    el.innerHTML = `
      <img src="${a.sprite}" alt="">
      <div class="pf-t">${a.title} ${badge}</div>
      <div class="pf-cf" style="color:${cf >= 0 ? 'var(--green)' : 'var(--red)'}">
        ${cf >= 0 ? '+' : ''}${euro(cf)}</div>
      <button class="btn-ghost btn-sm" data-sell="${a.instanceId}">Vender</button>`;
    wrap.appendChild(el);
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
  const snap = engine.endTurn();
  const ev = snap.event;
  const tone = ev ? ev.tone : 'neutral';
  let desc = ev ? ev.description : '';
  if (snap.adj && snap.adj._vacancyAsset) desc += ` (${snap.adj._vacancyAsset})`;

  city.emitCoins();
  $('hud-month').textContent = engine.month;

  const sign = snap.cashflow >= 0 ? '+' : '';
  toast(`📅 Mes ${engine.month - 1} · ${ev ? ev.title : 'Liquidación'}`,
    `${desc}  ·  Cashflow del mes: ${sign}${euro(snap.cashflow)}`, tone);

  // turno de los oponentes IA
  bots.forEach(b => {
    takeBotTurn(b.engine, DATA.assets, b.aggr);
    b.engine.endTurn();
  });

  refreshMarket();
  render();
  checkEnd();
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
    endModal('💥 Insolvencia',
      `Tu caja cayó a ${euro(s.cash)}. El exceso de deuda o los imprevistos ahogaron tu tesorería.
       Vuelve a intentarlo ajustando el apalancamiento.`, false);
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

function endModal(title, html, win) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" style="text-align:center;max-width:520px">
      <div style="font-size:64px">${win ? '🏆' : '💥'}</div>
      <h2>${title}</h2>
      <p class="lead">${html}</p>
      <button class="btn-primary" onclick="location.reload()">Jugar otra vez</button>
    </div>`;
  document.body.appendChild(ov);
}

/* ------------------ ACCIONES DEUDA (liquidez) --------------------- */
function wireDebtButtons() {
  $('btn-loan').onclick = () => {
    engine.takeConsumerLoan(5000);
    toast('Préstamo de consumo', 'Entran 5.000 € a caja, pero suma DEUDA ROJA que penaliza tu IE.', 'bad');
    render();
  };
  $('btn-repay').onclick = () => {
    if (!engine.redDebts.length) { toast('Sin deuda roja', 'No tienes préstamos de consumo que amortizar.', 'neutral'); return; }
    const r = engine.repayRedDebt(engine.redDebts[0].id);
    if (r.ok) { toast('Deuda roja amortizada', 'Has cancelado un préstamo de consumo.', 'good'); render(); }
    else toast('No se pudo amortizar', r.reason, 'bad');
  };
}

/* ---------------------------- RENDER ------------------------------ */
function render() {
  const s = engine.status();
  const salary = engine.profile.salary_base;

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
  $('passive').textContent = '+' + euro(s.passiveIncome);
  $('expenses').textContent = '−' + euro(s.fixedExpenses);
  $('flow-red').textContent = '−' + euro(s.redDebt);
  const netEl = $('flow-net');
  netEl.textContent = (cf >= 0 ? '+' : '−') + euro(Math.abs(cf));
  netEl.className = 'val ' + (cf >= 0 ? 'green' : 'red');

  // Deuda verde/roja
  const totalDebt = s.greenDebt + s.redDebt || 1;
  $('db-green').style.width = (s.greenDebt / totalDebt * 100) + '%';
  $('db-red').style.width = (s.redDebt / totalDebt * 100) + '%';
  $('green-lbl').textContent = euro(s.greenDebt) + '/mes';
  $('red-lbl').textContent = euro(s.redDebt) + '/mes';

  // HUD
  $('hud-assets').textContent = s.assetsCount;
  $('hud-month').textContent = s.month;

  renderPortfolio();
  renderStandings();
  drawSparkline();
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
  wireDebtButtons();

  // Arranque rápido para demos/test:  index.html?auto=corporate|freelance|investor
  const params = new URLSearchParams(location.search);
  const auto = params.get('auto');
  if (auto) {
    const p = DATA.profiles.find(x => x.id === auto) || DATA.profiles[0];
    await startGame(p);
    if (params.get('demo')) {
      // compra oportunidades asequibles y pasa varios meses (solo test/demo)
      const turns = parseInt(params.get('demo'), 10) || 1;
      for (let t = 0; t < turns; t++) {
        market.slice().forEach(a => {
          const fin = a.leverage_allowed && engine.canBuy(a, 'leverage').ok ? 'leverage'
                    : engine.canBuy(a, 'cash').ok ? 'cash' : null;
          if (fin) doBuy(a.id, fin);
        });
        if (!ended) endTurn();
      }
    }
  }
})();
