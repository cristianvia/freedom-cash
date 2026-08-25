/**
 * Upgrades.js
 * ------------------------------------------------------------------
 * Mejorar un edificio sin moverlo del sitio.
 *
 * EL PROBLEMA QUE RESUELVE
 *
 * La isla tiene techo: unos 150 solares de media, y deja de crecer en el
 * nivel 14. Cuando se llena, el jugador se queda mirando la ciudad sin
 * poder hacer nada. La salida vertical que existía —fundir tres iguales—
 * solo alcanza a 13 de los 53 activos: cuarenta no tienen escalón
 * superior y no se pueden mejorar jamás.
 *
 * Con la mejora en el sitio, el suelo deja de ser el techo, porque lo que
 * crece es el valor POR SOLAR. Y funciona con los cincuenta y tres, sin
 * inventar un solo activo nuevo.
 *
 * LA FORMA DE LA CURVA, QUE ES LO QUE ENSEÑA
 *
 * Mejorar renta menos por euro que comprar algo nuevo, y cada vez menos:
 *
 *   nivel 2:  pagas 0,60 × precio  →  ganas 0,45 × renta   (75% del yield)
 *   nivel 3:  pagas 1,20 × precio  →  ganas 0,65 × renta   (54%)
 *   nivel 4:  pagas 1,80 × precio  →  ganas 0,95 × renta   (44%)
 *
 * A cambio no consume suelo. Esa es exactamente la decisión que se quiere
 * enseñar: mientras tengas sitio, comprar nuevo rinde más; cuando el
 * suelo se acaba, mejorar lo que tienes es la única forma de que el
 * dinero siga trabajando. Es dejar de crecer a lo ancho y empezar a
 * componer.
 * ------------------------------------------------------------------
 */

import { tierRules } from './rules.js';

export const MAX_LEVEL = 5;

/** Cuánto más renta cada nivel. Y el mantenimiento también sube. */
const INCOME_STEP = 1.45;
const MAINT_STEP = 1.30;

/** Coste en caja: proporcional al precio del activo y al nivel que ya tiene. */
const COST_FACTOR = 0.60;

export function levelOf(asset) { return asset.upLevel || 1; }

export function canLevelUp(asset) {
  return !!asset && !asset.ruined && levelOf(asset) < MAX_LEVEL;
}

/** Lo que cuesta subir un escalón: caja, materiales y tiempo de obra. */
export function upgradeCost(asset, tier) {
  const lvl = levelOf(asset);
  const base = asset.financials.total_price;
  const r = tierRules(tier);
  return {
    cash: Math.round(base * COST_FACTOR * lvl),
    materials: Math.round(r.materials * (1 + lvl * 0.8)),
    buildMs: Math.round(r.buildMs * (1 + lvl * 0.5)),
    level: lvl + 1,
  };
}

/** Renta mensual que tendría tras la mejora, para poder compararla antes. */
export function incomeAfter(engine, asset) {
  const probe = {
    ...asset,
    financials: {
      ...asset.financials,
      gross_monthly_income: asset.financials.gross_monthly_income * INCOME_STEP,
      maintenance_and_taxes: asset.financials.maintenance_and_taxes * MAINT_STEP,
    },
  };
  return engine.assetNetIncome(probe);
}

/**
 * Aplica la mejora sobre el activo del motor.
 *
 * Se tocan las CIFRAS del activo y no se añade nada al motor a propósito:
 * así la renta, el valor de mercado, los impuestos y el indicador se
 * recalculan solos, sin que EconomyEngine tenga que enterarse de que
 * existen las mejoras.
 *
 * @returns {{ok:boolean, reason?:string, cost?:object}}
 */
export function levelUp(engine, city, asset, tier) {
  if (!canLevelUp(asset)) {
    return { ok: false, reason: 'Ya está al máximo' };
  }
  const cost = upgradeCost(asset, tier);
  if (engine.cash < cost.cash) return { ok: false, reason: 'Liquidez insuficiente' };
  if (city.materials < cost.materials) {
    return { ok: false, reason: 'Te faltan ' + (cost.materials - city.materials) + ' 🧱' };
  }

  engine.cash -= cost.cash;
  city.spendMaterials(cost.materials);

  const f = asset.financials;
  f.gross_monthly_income = Math.round(f.gross_monthly_income * INCOME_STEP);
  f.maintenance_and_taxes = Math.round(f.maintenance_and_taxes * MAINT_STEP);
  // El precio sube con lo invertido: si no, mejorar destruiría patrimonio
  // en los libros aunque la renta subiese.
  f.total_price = Math.round(f.total_price + cost.cash);
  asset.upLevel = cost.level;

  return { ok: true, cost };
}

/**
 * Modelo que le toca a un activo según su categoría, su escalón base y
 * cuántas veces se ha mejorado. Es lo que hace que la mejora se VEA: un
 * trastero mejorado deja de ser una caseta.
 */
export function spriteForLevel(models, asset, baseTier, level) {
  const ladder = models.ladder && models.ladder[asset.category];
  if (!ladder || !ladder.length) return null;
  const tier = Math.max(1, Math.min(ladder.length, baseTier + level - 1));
  const rung = ladder[tier - 1];
  if (!rung || !rung.length) return null;
  // el mismo activo elige siempre el mismo modelo dentro de su escalón
  return rung[hashStr(asset.baseId || asset.id) % rung.length];
}

/** FNV-1a, el mismo que usa el generador del catálogo. */
function hashStr(s) {
  let h = 2166136261 >>> 0;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
