/**
 * tools/eras.mjs — ¿Hasta dónde aguanta el Modo Legado?
 * Encadena eras con la IA como jugador de referencia y reporta cuántos meses
 * cuesta cada una y dónde se atasca. Sirve para calibrar el espaciado.
 *
 *   node tools/eras.mjs [eras] [partidas]
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { EconomyEngine, ERA_ASSET_STEP, eraLabel } from '../src/engine/EconomyEngine.js';
import { takeBotTurn } from '../src/engine/BotAI.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = (f) => JSON.parse(readFileSync(join(ROOT, 'src/data', f), 'utf8'));
const A = data('assets_database.json').assets, P = data('profiles.json').profiles;
const E = data('events.json').events, L = data('lifestyle.json').actions;
const V = data('vehicles.json').vehicles, G = data('gigs.json').gigs;
const MODES = data('difficulty.json').modes;

const TIERS = ['', 'Plus', 'Prime', 'Élite', 'Legendario', 'Mítico', 'Ancestral', 'Absoluto'];

/** Réplica de eraCatalog() de main.js, para simular el mercado de cada era. */
function eraCatalog(assets, era, inflation = 1) {
  if (era <= 1 && inflation < 1.02) return assets;
  const k = Math.pow(ERA_ASSET_STEP, era - 1) * inflation;
  const y = k * (1 + 0.06 * (era - 1));
  const sc = (v, m) => Math.round((v || 0) * m);
  return assets.map(a => {
    const f = a.financials;
    return {
      ...a, id: `${a.id}@e${era}`, title: `${a.title} · ${TIERS[Math.min(era, TIERS.length) - 1]}`,
      financials: {
        total_price: sc(f.total_price, k),
        down_payment_required: sc(f.down_payment_required, k),
        mortgage_available: sc(f.mortgage_available, k),
        monthly_mortgage_cost: sc(f.monthly_mortgage_cost, k),
        gross_monthly_income: sc(f.gross_monthly_income, y),
        maintenance_and_taxes: sc(f.maintenance_and_taxes, k),
        net_monthly_cashflow: sc(f.gross_monthly_income, y) - sc(f.maintenance_and_taxes, k),
      },
      metrics: { ...a.metrics,
        vacancy_rate_risk: Math.min(0.6, (a.metrics.vacancy_rate_risk || 0) * (1 + 0.12 * (era - 1))) },
    };
  });
}

const MAX_ERA = parseInt(process.argv[2], 10) || 10;
const RUNS = parseInt(process.argv[3], 10) || 12;
const CAP = 400;   // meses máximos por era antes de declararla atascada

for (const profile of [P[0]]) {
  const perEra = Array.from({ length: MAX_ERA + 1 }, () => []);
  let stuckAt = {};
  for (let n = 0; n < RUNS; n++) {
    const e = new EconomyEngine(profile, E, MODES[0]);
    for (let era = 1; era <= MAX_ERA; era++) {
      const start = e.month;
      let guard = CAP;
      while (!e.hasWon() && !e.hasLost() && guard-- > 0) {
        takeBotTurn(e, eraCatalog(A, e.era, e.expenseInflation), L, V, 0.8, G);
        e.endTurn();
      }
      if (e.hasLost()) { stuckAt[`era${era}:${e.lossReason()}`] = (stuckAt[`era${era}:${e.lossReason()}`] || 0) + 1; break; }
      if (!e.hasWon()) { stuckAt[`era${era}:atascado`] = (stuckAt[`era${era}:atascado`] || 0) + 1; break; }
      perEra[era].push(e.month - start);
      e.startNewEra();
    }
  }
  console.log(`Perfil ${profile.id} · ${RUNS} partidas\n`);
  perEra.forEach((list, era) => {
    if (!era || !list.length) return;
    const avg = Math.round(list.reduce((s, v) => s + v, 0) / list.length);
    console.log(`  ${eraLabel(era).padEnd(26)} superada ${String(list.length).padStart(2)}/${RUNS} · ${String(avg).padStart(3)} meses de media`);
  });
  console.log('\n  Atascos:', Object.keys(stuckAt).length ? JSON.stringify(stuckAt) : 'ninguno');
}
