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
export function takeBotTurn(engine, assets, aggressiveness = 0.6) {
  const buys = [];
  let attempts = 2;

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

    // conserva un colchón de 2 meses de gastos
    const buffer = engine.fixedExpenses() * 2;
    if (engine.cash - pick.cost < buffer) break;

    const r = engine.buyAsset(pick.a, pick.fin);
    if (!r.ok) break;
    buys.push(pick.a.title);
  }
  return buys;
}
