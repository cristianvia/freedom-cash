/**
 * BotAI.js — IA sencilla para oponentes.
 * Cada bot usa su propia EconomyEngine. En su turno intenta comprar
 * de 0 a 2 activos priorizando el mejor rendimiento por euro invertido,
 * manteniendo siempre un colchón de liquidez.
 */

/**
 * @param {EconomyEngine} engine   estado del bot
 * @param {object[]} assets        catálogo completo
 * @param {number} aggressiveness  0..1  probabilidad de seguir comprando
 * @returns {string[]} títulos de los activos comprados este turno
 */
export function takeBotTurn(engine, assets, lifestyle = [], vehicles = [], aggressiveness = 0.6, gigs = []) {
  const buys = [];
  let attempts = 2;

  // 0a) Trabajos extra: si va justo de liquidez y tiene energía, se busca la vida.
  //     En apuros hace hasta 2 gigs; descansa gratis para poder seguir currando.
  if (engine.gigsEnabled() && gigs.length) {
    const tight = engine.cash < engine.fixedExpenses() * 3;
    let gigsThisTurn = 0;
    while (tight && engine.energy > 22 && gigsThisTurn < 2) {
      const g = gigs.filter(x => !engine.gigsUsed.has(x.id))
        .sort((a, b) => (b.cash / -(b.energy || 1)) - (a.cash / -(a.energy || 1)))[0];
      if (!g) break;
      const r = engine.doGig(g);
      if (!r.ok) break;
      gigsThisTurn++;
    }
    if (engine.energy < 30) { const rest = lifestyle.find(l => l.id === 'rest'); if (rest) engine.doLifestyle(rest); }
  }

  // 0b) Vehículo: compra un coche usado modesto al contado cuando puede (evita la deuda roja del coche)
  if (vehicles && vehicles.length && !engine.vehicle &&
      engine.cash > 4500 + engine.fixedExpenses() * 3) {
    const used = vehicles.find(v => v.id === 'used');
    if (used) engine.chooseVehicle(used, 'cash');
  }

  // 0) Cuidar el bienestar (si no, se abandona por felicidad 0 o cae en burnout)
  if (lifestyle && lifestyle.length) {
    if (engine.energy < 40) {
      const rest = lifestyle.find(l => l.id === 'rest');
      if (rest) engine.doLifestyle(rest);
    }
    if (engine.happiness < 48) {
      const opts = lifestyle
        .filter(l => (l.happiness || 0) > 0 && engine.cash > l.cost + engine.fixedExpenses())
        .sort((a, b) => (b.happiness / (b.cost + 1)) - (a.happiness / (a.cost + 1)));
      if (opts[0]) engine.doLifestyle(opts[0]);
    }
    // formación ocasional cuando va sobrado de energía y liquidez
    if (engine.energy > 62 && engine.cash > 15000 && Math.random() < 0.2) {
      const course = lifestyle.find(l => l.id === 'course');
      if (course) engine.doLifestyle(course);
    }
  }

  // 1) Optimización fiscal: constituir sociedad cuando compensa
  if (engine.taxVehicle === 'personal' &&
      engine.incorporationBenefit() > 40 &&
      engine.cash > engine.COMPANY_SETUP + engine.fixedExpenses() * 2) {
    engine.incorporate();
  }

  // 2) Refinanciar una hipoteca si los tipos han subido
  if (engine.mortgageModifier > 1.05) {
    const target = engine.ownedAssets.find(a => a.financing === 'leverage' && !a.refinanced);
    if (target && engine.canRefinance(target.instanceId).ok) {
      engine.refinanceAsset(target.instanceId);
    }
  }

  while (attempts-- > 0) {
    if (Math.random() > aggressiveness) break;

    // opciones asequibles, puntuadas por cashflow neto por euro aportado
    const options = assets.map(a => {
      const canLev = a.leverage_allowed && engine.canBuy(a, 'leverage').ok;
      const canCash = engine.canBuy(a, 'cash').ok;
      if (!canLev && !canCash) return null;
      const fin = canLev ? 'leverage' : 'cash';
      const cost = fin === 'leverage'
        ? a.financials.down_payment_required
        : a.financials.total_price;
      const score = a.financials.net_monthly_cashflow / Math.max(1, cost);
      return { a, fin, cost, score };
    }).filter(Boolean).sort((x, y) => y.score - x.score);

    if (!options.length) break;

    // elige entre las 3 mejores (algo de aleatoriedad de personalidad)
    const pick = options[Math.floor(Math.random() * Math.min(3, options.length))];

    // conserva un colchón de 1 mes de gastos (reinvierte pronto, como un jugador hábil)
    const buffer = engine.fixedExpenses() * 1;
    if (engine.cash - pick.cost < buffer) break;

    const r = engine.buyAsset(pick.a, pick.fin);
    if (!r.ok) break;
    buys.push(pick.a.title);
  }
  return buys;
}
