/**
 * EconomyEngine.js
 * ------------------------------------------------------------------
 * Núcleo contable de "Freedom Cash". Sin dependencias de UI.
 * Gestiona: perfil, liquidez, portfolio, deudas (verde/roja),
 * liquidación mensual, eventos macro y condición de victoria (IE).
 *
 *   IE = (Ingresos Pasivos Mensuales / (Gastos Fijos + Cuotas Deuda Roja)) * 100
 *   Victoria = IE >= 120  Y  caja >= 6 * gastos_fijos
 * ------------------------------------------------------------------
 */

export const WIN_IE = 120;          // Indicador de Emancipación objetivo (%) en la era 1
export const WIN_MONTHS_CUSHION = 6; // colchón de tesorería (meses de gastos)

/* --- Modo Legado: al ganar puedes encadenar "eras" cada vez más exigentes --- */
export const ERA_IE_STEP = 0.35;    // el listón de IE sube un 35% por era
export const ERA_RISK_STEP = 1.25;  // los eventos negativos pegan un 25% más fuerte
export const ERA_CREDIT_STEP = 1.7; // pero tu límite de crédito crece un 70%
export const ERA_LIFE_COST = 0.12;  // tu nivel de vida sube un 12% de los gastos base
export const ERA_ASSET_STEP = 1.55; // el mercado ofrece activos ~55% mayores por era

/** Nombre narrativo de cada era (se repite el último si se pasa de la lista). */
export const ERA_NAMES = [
  'Emancipación', 'Consolidación', 'Expansión', 'Patrimonio', 'Imperio', 'Legado',
];

/* --- Ciclo económico: la marea que sube y baja todos los barcos --- */
/*
 * El mercado ya no es un telón de fondo estático. Cuatro fases se encadenan y
 * mueven a la vez precios, rentas, riesgo y valor de reventa. Comprar en
 * recesión y vender en pico es, por fin, una jugada — y equivocarse duele.
 */
export const CYCLE_PHASES = [
  { id: 'expansion', label: 'Expansión', emoji: '📈', tone: 'good',
    desc: 'Todo sube: rentas fuertes y poco riesgo, pero comprar ya no es barato.',
    price: 1.06, yield: 1.06, risk: 0.85, months: [4, 7] },
  { id: 'peak', label: 'Pico de mercado', emoji: '🎈', tone: 'warn',
    desc: 'Burbuja: los activos están carísimos. Vender ahora es el mejor negocio.',
    price: 1.20, yield: 1.02, risk: 1.15, months: [2, 4] },
  { id: 'recession', label: 'Recesión', emoji: '📉', tone: 'bad',
    desc: 'Las rentas caen y sube la vacancia… pero todo está de rebajas. Si tienes caja, es TU momento.',
    price: 0.76, yield: 0.86, risk: 1.40, months: [3, 6] },
  { id: 'recovery', label: 'Recuperación', emoji: '🌤️', tone: 'neutral',
    desc: 'El mercado despierta: los precios aún no se han enterado del todo.',
    price: 0.90, yield: 0.97, risk: 1.05, months: [3, 6] },
];

/** Etiqueta legible de una era ("Era 3 · Expansión"). */
export function eraLabel(era) {
  return `Era ${era} · ${ERA_NAMES[Math.min(era, ERA_NAMES.length) - 1]}`;
}

export class EconomyEngine {
  /**
   * @param {object} profile  ficha de vida (de profiles.json)
   * @param {object[]} events  lista de eventos (de events.json)
   * @param {object} mode      modo de dificultad (de difficulty.json)
   */
  constructor(profile, events = [], mode = null) {
    this.profile = profile;
    this.events = events;
    this.mode = mode || { id: 'easy', cashMult: 1, salaryMult: 1, extraRent: 0, gigs: false, scoreMult: 1 };
    this.professionId = 'none'; // profesión: desbloquea proyectos temáticos

    this.month = 1;
    this.cash = Math.round(profile.starting_cash * this.mode.cashMult);
    this.extraRent = this.mode.extraRent || 0;
    this.gigsUsed = new Set();
    this.ownedAssets = [];   // { ...asset, financing:'cash'|'leverage', instanceId, refinanced? }
    this.redDebts = [];      // { id, label, balance, monthly_payment }
    this.mortgageModifier = 1; // acumulado por subidas/bajadas de tipos (deuda verde)
    this.history = [];       // snapshots de IE por mes (para la gráfica)
    this._seq = 0;

    // --- Vehículo fiscal (persona física vs sociedad) ---
    this.taxVehicle = 'personal';
    this.TAX_THRESHOLD = 2000;  // renta pasiva/mes exenta de recargo (persona física)
    this.PERSONAL_TAX = 0.25;   // recargo sobre el exceso de renta pasiva (persona física)
    this.COMPANY_SETUP = 4000;  // coste único de constituir la sociedad
    this.COMPANY_MONTHLY = 220; // gestoría/impuestos fijos de la sociedad

    // --- Refinanciación de hipotecas ---
    this.REFI_FEE_PCT = 0.03;   // comisión (sobre la hipoteca) por refinanciar
    this.REFI_REDUCTION = 0.25; // reducción de la cuota tras refinanciar

    // --- Ciclo económico (se arranca en 'recuperación': hay margen para entrar) ---
    this.cycleIndex = 3;
    this.cycleLeft = 4;

    // --- Acciones por mes: tu tiempo es el recurso más escaso ---
    this.ACTIONS_BASE = 3;      // jugadas que caben en un mes
    this.ACTIONS_MAX = 5;       // tope aunque encadenes eras
    this.actionsUsed = 0;

    // --- Horquilla de rendimiento: ningún activo renta lo mismo todos los meses ---
    this.YIELD_SPREAD_BASE = 0.10;  // volatilidad mínima (hasta un bono se mueve)
    this.YIELD_SPREAD_RISK = 0.80;  // cuánto amplía la horquilla el riesgo del activo
    this.YIELD_SPREAD_MAX = 0.60;   // tope de la horquilla (±60%)

    // --- Traspasos entre jugadores (mercado P2P) ---
    this.APPRECIATION_MONTH = 0.0075; // el capital se revaloriza ~9%/año mientras renta
    this.APPRECIATION_MAX = 0.45;     // tope de revalorización acumulada
    this.TRANSFER_COST_PCT = 0.04;    // notaría/gestión de un traspaso (lo paga el comprador)

    // --- Bienestar: Felicidad y Energía (0-100) ---
    this.happiness = 70;
    this.energy = 80;
    this.salaryBoost = 1;              // sube con formación/ascensos
    this.lifestyleUsed = new Set();    // acciones de estilo de vida usadas este mes
    this.WORK_ENERGY_DRAIN = 7;        // energía que consume el trabajo cada mes
    this.HAPPINESS_DRIFT = 3;          // desgaste base de felicidad (la rutina)
    this.BURNOUT_ENERGY = 25;          // por debajo → burnout (penaliza el sueldo)
    this.BURNOUT_SALARY_MULT = 0.65;   // multiplicador de sueldo en burnout

    // --- Vehículo (un coche es un pasivo: sube tus gastos fijos) ---
    this.vehicle = null;         // null = transporte público por defecto
    this.NO_CAR_TRANSPORT = 45;  // abono de transporte si no tienes coche

    // --- Inflación y hitos de vida (tu coste de vida sube con el tiempo) ---
    this.expenseInflation = 1;   // ~4,9%/año; obliga a no quedarte quieto
    this.lifeExpenses = 0;       // gasto extra permanente por hitos (pareja, hijos...)
    this.firedOnce = new Set();  // eventos "once" ya disparados
    this.INFLATION_BASE = 1.003; // inflación mensual de la era 1

    // --- Modo Legado: era actual y sus modificadores acumulados ---
    this.era = 1;
    this.eraRisk = 1;      // multiplica los golpes negativos de los eventos
    this.creditBoost = 1;  // multiplica tu límite de crédito
    this.eraStartMonth = 1; // mes en el que empezó la era actual

    // --- Coste de arranque (fianza + mudanza): el principio pesa ---
    this.cash -= Math.round(profile.fixed_expenses * 1.5);

    this.recordSnapshot();
  }

  /* ---------------------------- INGRESOS ---------------------------- */

  /** Factor de productividad por energía (burnout reduce el sueldo). */
  energyFactor() {
    return this.energy < this.BURNOUT_ENERGY ? this.BURNOUT_SALARY_MULT : 1;
  }

  /** Sueldo base efectivo: perfil × dificultad × mejoras (formación) × energía. */
  effectiveSalaryBase() {
    return this.profile.salary_base * this.mode.salaryMult * this.salaryBoost * this.energyFactor();
  }

  isBurnout() { return this.energy < this.BURNOUT_ENERGY; }

  /* ------------------------ ACCIONES DEL MES ------------------------ */
  /*
   * El dinero no es el único límite: el mes tiene un número de jugadas.
   * Comprar, currar un extra, cuidarte o cerrar un traspaso compiten por el
   * mismo hueco, así que cada turno obliga a priorizar. La experiencia
   * (encadenar eras) da margen; el burnout te lo quita.
   */

  actionsMax() {
    const era = Math.min(this.ACTIONS_MAX - this.ACTIONS_BASE, this.era - 1);
    return Math.max(1, this.ACTIONS_BASE + era - (this.isBurnout() ? 1 : 0));
  }

  actionsLeft() { return Math.max(0, this.actionsMax() - this.actionsUsed); }

  /** ¿Queda jugada este mes? Motivo listo para enseñar en el botón. */
  canAct() {
    return this.actionsLeft() > 0
      ? { ok: true }
      : { ok: false, reason: this.isBurnout()
          ? 'Sin acciones: el burnout te deja un mes muy corto'
          : 'Sin acciones este mes — pasa de mes para recuperarlas' };
  }

  spendAction(n = 1) { this.actionsUsed += n; }

  /** Sueldo del mes (aplica varianza si el perfil es variable). */
  rollSalary() {
    const base = this.effectiveSalaryBase();
    const { salary_variance } = this.profile;
    if (!salary_variance) return Math.round(base);
    const delta = (Math.random() * 2 - 1) * salary_variance * this.mode.salaryMult * this.salaryBoost * this.energyFactor();
    return Math.round(base + delta);
  }

  /* --------------------------- BIENESTAR ---------------------------- */

  _clampWellbeing() {
    this.happiness = Math.max(0, Math.min(100, this.happiness));
    this.energy = Math.max(0, Math.min(100, this.energy));
  }

  /* ---------------------------- VEHÍCULO ---------------------------- */

  vehicleMonthlyCost() {
    return this.vehicle ? this.vehicle.monthly : this.NO_CAR_TRANSPORT;
  }

  /** Valor de reventa del coche actual (~55% de lo que costó). */
  vehicleResaleValue() {
    return this.vehicle && this.vehicle.price ? Math.round(this.vehicle.price * 0.55) : 0;
  }

  /** Vende el coche actual y vuelve a transporte público. */
  sellVehicle() {
    if (!this.vehicle) return { ok: false, reason: 'No tienes coche' };
    const proceeds = this.vehicleResaleValue();
    this.cash += proceeds;
    this.vehicle = null;
    return { ok: true, proceeds };
  }

  /** Elige/compra un vehículo. financing: 'cash' | 'loan' (loan = deuda roja). */
  chooseVehicle(v, financing = 'cash') {
    // "sin coche": si tenías uno, lo vendes por su valor residual
    if (v.id === 'none') {
      if (this.vehicle) return this.sellVehicle();
      this.vehicle = null;
      return { ok: true, proceeds: 0 };
    }
    const upfront = (financing === 'loan' && v.financeable) ? Math.round(v.price * 0.15) : v.price;
    if (this.cash < upfront) return { ok: false, reason: 'Liquidez insuficiente' };
    const act = this.canAct();
    if (!act.ok) return { ok: false, reason: act.reason };
    this.spendAction();
    // si ya tenías coche, primero recuperas su valor residual (cambio de coche)
    if (this.vehicle) this.cash += this.vehicleResaleValue();
    this.cash -= upfront;
    if (financing === 'loan' && v.financeable && v.price > upfront) {
      const financed = v.price - upfront;
      const monthly = Math.round(financed * 1.18 / 48); // 18% total a 48 meses → DEUDA ROJA
      this.redDebts.push({
        id: `car#${++this._seq}`,
        label: `Préstamo coche`,
        balance: Math.round(financed * 1.18),
        monthly_payment: monthly,
      });
    }
    this.vehicle = { id: v.id, label: v.label, emoji: v.emoji, sprite: v.sprite, monthly: v.monthly, price: v.price };
    this.happiness += v.happiness || 0;
    this._clampWellbeing();
    return { ok: true };
  }

  /** ¿Hay trabajos extra disponibles en este modo? */
  gigsEnabled() { return !!this.mode.gigs; }

  /** Hace un trabajo extra: entra dinero ya, cuesta energía (y a veces felicidad). */
  doGig(gig) {
    if (!this.gigsEnabled()) return { ok: false, reason: 'No disponible en este modo' };
    if (this.gigsUsed.has(gig.id)) return { ok: false, reason: 'Ya lo hiciste este mes' };
    if (this.energy < 6) return { ok: false, reason: 'Sin energía para más trabajo' };
    const act = this.canAct();
    if (!act.ok) return { ok: false, reason: act.reason };
    this.spendAction();
    this.cash += gig.cash || 0;
    this.energy += gig.energy || 0;
    if (gig.happiness) this.happiness += gig.happiness;
    this._clampWellbeing();
    this.gigsUsed.add(gig.id);
    return { ok: true, earned: gig.cash };
  }

  /** Ejecuta una acción de estilo de vida (cuesta dinero, ajusta bienestar). */
  doLifestyle(action) {
    if (this.lifestyleUsed.has(action.id)) return { ok: false, reason: 'Ya lo hiciste este mes' };
    if (this.cash < action.cost) return { ok: false, reason: 'Liquidez insuficiente' };
    const act = this.canAct();
    if (!act.ok) return { ok: false, reason: act.reason };
    this.spendAction();
    this.cash -= action.cost;
    this.happiness += action.happiness || 0;
    this.energy += action.energy || 0;
    if (action.salaryBoost) this.salaryBoost += action.salaryBoost;
    this._clampWellbeing();
    this.lifestyleUsed.add(action.id);
    return { ok: true };
  }

  /** Cuota hipotecaria efectiva de un activo (tipos + refinanciación). */
  mortgageCostOf(a) {
    if (a.financing !== 'leverage') return 0;
    // un activo refinanciado fija su tipo (inmune a subidas) y baja la cuota
    const rate = a.rateLocked ? 1 : this.mortgageModifier;
    return a.financials.monthly_mortgage_cost * rate * (a.refiFactor ?? 1);
  }

  /* ------------------------ CICLO ECONÓMICO ------------------------- */

  cyclePhase() { return CYCLE_PHASES[this.cycleIndex]; }
  cyclePriceMult() { return this.cyclePhase().price; }
  cycleYieldMult() { return this.cyclePhase().yield; }
  cycleRiskMult() { return this.cyclePhase().risk; }

  /** Avanza el reloj del ciclo. Devuelve la fase nueva si acaba de cambiar. */
  advanceCycle() {
    this.cycleLeft -= 1;
    if (this.cycleLeft > 0) return null;
    this.cycleIndex = (this.cycleIndex + 1) % CYCLE_PHASES.length;
    const [a, b] = this.cyclePhase().months;
    this.cycleLeft = Math.round(a + Math.random() * (b - a));
    return this.cyclePhase();
  }

  /** Copia el ciclo de otro motor: la macro es del mundo, no de cada jugador. */
  setCycle(index, left) { this.cycleIndex = index; this.cycleLeft = left; }

  /* --------------------- PRECIOS SEGÚN EL CICLO --------------------- */

  /**
   * Ficha económica de un activo AL PRECIO DE HOY. El ciclo mueve precio,
   * entrada, hipoteca y cuota a la vez (si compras más barato, debes menos).
   */
  pricedFinancials(asset) {
    const f = asset.financials;
    const k = this.cyclePriceMult();
    return {
      ...f,
      total_price: Math.round(f.total_price * k),
      down_payment_required: Math.round(f.down_payment_required * k),
      mortgage_available: Math.round(f.mortgage_available * k),
      monthly_mortgage_cost: Math.round(f.monthly_mortgage_cost * k),
    };
  }

  /* -------------------- HORQUILLA DE RENDIMIENTO -------------------- */

  /**
   * Amplitud de la horquilla de un activo (±%). Un bono apenas se mueve;
   * un negocio digital o el cripto oscilan muchísimo. El riesgo del activo
   * (vacancia/volatilidad) es lo que ensancha la banda.
   */
  yieldSpread(a) {
    const risk = ((a.metrics && a.metrics.vacancy_rate_risk) || 0) * this.cycleRiskMult();
    return Math.min(this.YIELD_SPREAD_MAX, this.YIELD_SPREAD_BASE + this.YIELD_SPREAD_RISK * risk);
  }

  /** Renta bruta del mes de un activo: catálogo × ciclo × sorteo de la horquilla. */
  grossIncomeOf(a) {
    return a.financials.gross_monthly_income * this.cycleYieldMult() * (a.yieldFactor ?? 1);
  }

  /**
   * Horquilla de cashflow neto mensual de un activo: entre `min` y `max`,
   * con `expected` como valor central. Es lo que se enseña en el Marketplace:
   * no compras "un número", compras un rango de resultados posibles.
   * @returns {{min:number, max:number, expected:number, spread:number}}
   */
  incomeBand(a) {
    const f = a.financials;
    const spread = this.yieldSpread(a);
    const fixed = f.maintenance_and_taxes + this.mortgageCostOf(a);
    const gross = f.gross_monthly_income * this.cycleYieldMult();
    return {
      min: gross * (1 - spread) - fixed,
      max: gross * (1 + spread) - fixed,
      expected: gross - fixed,
      spread,
    };
  }

  /**
   * Sortea el rendimiento del próximo mes dentro de la horquilla.
   * Media de dos uniformes → distribución triangular: lo normal es quedarse
   * cerca del valor esperado y los extremos son raros (pero existen).
   */
  rollYieldFactor(a) {
    const spread = this.yieldSpread(a);
    const u = (Math.random() + Math.random()) / 2;   // 0..1 centrado en 0,5
    return 1 + (u * 2 - 1) * spread;
  }

  /** Fija el rendimiento del mes que empieza para todo el portfolio. */
  rollYields() {
    this.ownedAssets.forEach(a => { a.yieldFactor = this.rollYieldFactor(a); });
  }

  /** Renta pasiva neta de un activo (bruto del mes - mantenimiento - hipoteca efectiva). */
  assetNetIncome(a) {
    return this.grossIncomeOf(a) - a.financials.maintenance_and_taxes - this.mortgageCostOf(a);
  }

  /** Desviación del mes respecto al rendimiento esperado (%). 0 = en la media. */
  assetYieldDelta(a) {
    return Math.round(((a.yieldFactor ?? 1) - 1) * 100);
  }

  /** Suma de rentas pasivas netas de todo el portfolio (antes de impuestos). */
  totalPassiveIncome() {
    return this.ownedAssets.reduce((s, a) => s + this.assetNetIncome(a), 0);
  }

  /* --------------------------- FISCALIDAD --------------------------- */

  /** Coste fiscal mensual según el vehículo (persona física vs sociedad). */
  taxCost() {
    if (this.taxVehicle === 'company') return this.COMPANY_MONTHLY;
    // persona física: recargo sobre el exceso de renta pasiva
    const excess = Math.max(0, this.totalPassiveIncome() - this.TAX_THRESHOLD);
    return excess * this.PERSONAL_TAX;
  }

  /** Renta pasiva DESPUÉS de impuestos: lo que de verdad cuenta para el IE. */
  netPassiveIncome() {
    return this.totalPassiveIncome() - this.taxCost();
  }

  /* ---------------------------- DEUDAS ------------------------------ */

  totalGreenDebtPayment() {
    return this.ownedAssets
      .filter(a => a.financing === 'leverage')
      .reduce((s, a) => s + this.mortgageCostOf(a), 0);
  }

  totalRedDebtPayment() {
    return this.redDebts.reduce((s, d) => s + d.monthly_payment, 0);
  }

  totalRedDebtBalance() {
    return this.redDebts.reduce((s, d) => s + d.balance, 0);
  }

  /* ------------------------- MÉTRICAS CLAVE ------------------------- */

  fixedExpenses() {
    return Math.round(this.profile.fixed_expenses * this.expenseInflation) + this.lifeExpenses + this.extraRent;
  }

  /** Indicador de Emancipación (%). El coste del coche sube tu listón de libertad. */
  emancipationIndex() {
    const denom = this.fixedExpenses() + this.vehicleMonthlyCost() + this.totalRedDebtPayment();
    if (denom <= 0) return 0;
    return (this.netPassiveIncome() / denom) * 100;
  }

  /** Cashflow neto del mes (lo que entra realmente a caja). */
  netMonthlyCashflow(salary) {
    // netPassiveIncome() YA descuenta hipotecas (dentro de assetNetIncome) e
    // impuestos (taxCost). Restamos gastos fijos, coste del coche y deuda roja.
    const income = salary + this.netPassiveIncome();
    const outflow = this.fixedExpenses() + this.vehicleMonthlyCost() + this.totalRedDebtPayment();
    return income - outflow;
  }

  cashCushionMonths() {
    const fx = this.fixedExpenses();
    return fx > 0 ? this.cash / fx : 0;
  }

  /* --------------------------- MODO LEGADO -------------------------- */

  /** Listón de IE que hay que superar en la era actual (120, 162, 204...). */
  winTargetIE() {
    return Math.round(WIN_IE * (1 + ERA_IE_STEP * (this.era - 1)));
  }

  /** Límite de crédito efectivo: crece con cada era superada. */
  creditLimit() {
    return Math.round(this.profile.credit_limit * this.creditBoost);
  }

  /** Inflación mensual: se acelera con la era (el suelo se mueve más rápido). */
  inflationRate() {
    return 1 + (this.INFLATION_BASE - 1) * (1 + 0.5 * (this.era - 1));
  }

  /**
   * Encadena la siguiente era: sube el listón y las apuestas, pero también
   * tu capacidad de maniobra. Conservas caja, activos y aprendizajes.
   * @returns {object} resumen de los cambios, para mostrarlo en la UI
   */
  startNewEra() {
    const before = { target: this.winTargetIE(), credit: this.creditLimit() };

    this.era += 1;
    this.eraStartMonth = this.month;
    this.eraRisk *= ERA_RISK_STEP;
    this.creditBoost *= ERA_CREDIT_STEP;

    // tu nivel de vida sube contigo: más gasto fijo permanente
    const lifeAdd = Math.round(this.profile.fixed_expenses * ERA_LIFE_COST);
    this.lifeExpenses += lifeAdd;

    // los hitos "once" vuelven a estar disponibles: nueva etapa, nuevos imprevistos
    this.firedOnce = new Set();

    // respiro entre etapas: celebras el logro y recargas (sin llegar al tope)
    this.happiness = Math.min(100, this.happiness + 15);
    this.energy = Math.min(100, this.energy + 15);

    // los trabajos extra quedan disponibles de aquí en adelante
    this.mode = { ...this.mode, gigs: true, scoreMult: (this.mode.scoreMult || 1) * 1.25 };

    return {
      era: this.era,
      label: eraLabel(this.era),
      targetFrom: before.target,
      targetTo: this.winTargetIE(),
      creditFrom: before.credit,
      creditTo: this.creditLimit(),
      lifeAdd,
      riskPct: Math.round((ERA_RISK_STEP - 1) * 100),
    };
  }

  hasWon() {
    return this.emancipationIndex() >= this.winTargetIE() &&
           this.cash >= WIN_MONTHS_CUSHION * this.fixedExpenses();
  }

  hasLost() {
    // insolvencia (caja muy negativa) o abandono (felicidad agotada)
    return this.cash < -3000 || this.happiness <= 0;
  }

  lossReason() {
    if (this.happiness <= 0) return 'abandono';
    if (this.cash < -3000) return 'insolvencia';
    return null;
  }

  /* --------------------------- ACCIONES ----------------------------- */

  /** ¿Está este activo disponible para mí? Universal o de mi profesión. */
  assetEligible(asset) {
    return !asset.profession || asset.profession === this.professionId;
  }

  /**
   * ¿Puede el jugador permitirse comprar este activo con la financiación dada?
   * @returns {{ok:boolean, reason?:string, cost:number}}
   */
  canBuy(asset, financing) {
    const f = this.pricedFinancials(asset);   // el ciclo manda en el precio de hoy
    const act = this.canAct();
    if (!act.ok) {
      return { ok: false, reason: act.reason, noActions: true,
        cost: financing === 'leverage' ? f.down_payment_required : f.total_price };
    }
    if (financing === 'leverage') {
      if (!asset.leverage_allowed) return { ok: false, reason: 'Sin apalancamiento disponible', cost: f.total_price };
      if (f.mortgage_available > this.creditLimit()) {
        return { ok: false, reason: 'Supera tu límite de crédito', cost: f.down_payment_required };
      }
      const cost = f.down_payment_required;
      return { ok: this.cash >= cost, reason: 'Liquidez insuficiente para la entrada', cost };
    }
    const cost = f.total_price;
    return { ok: this.cash >= cost, reason: 'Liquidez insuficiente', cost };
  }

  /**
   * Compra un activo. financing: 'cash' | 'leverage'.
   * @returns {{ok:boolean, reason?:string, instance?:object}}
   */
  buyAsset(asset, financing) {
    const check = this.canBuy(asset, financing);
    if (!check.ok) return { ok: false, reason: check.reason };

    this.spendAction();
    this.cash -= check.cost;
    // el activo congela la ficha que pagaste: si compraste en recesión, tu
    // hipoteca y tu entrada siguen siendo las baratas para siempre
    const instance = {
      ...asset,
      financials: this.pricedFinancials(asset),
      financing,
      instanceId: `${asset.id}#${++this._seq}`,
      purchasedMonth: this.month,
      purchasePriceMult: this.cyclePriceMult(),
    };
    instance.yieldFactor = this.rollYieldFactor(instance);  // ya renta dentro de su horquilla
    this.ownedAssets.push(instance);
    return { ok: true, instance };
  }

  /* ------------------------ VALOR / TRASPASOS ----------------------- */

  /** Capital aportado (equity): al contado el precio entero; apalancado, la entrada. */
  assetEquity(a) {
    return a.financing === 'leverage'
      ? a.financials.down_payment_required
      : a.financials.total_price;
  }

  /**
   * Valor de traspaso: el capital revalorizado por los meses que lleva rentando
   * Y reajustado al precio de HOY. Comprar en recesión y vender en pico da una
   * plusvalía real; al revés, te comes la minusvalía.
   */
  assetTransferValue(a) {
    const held = Math.max(0, this.month - (a.purchasedMonth ?? this.month));
    const appr = 1 + Math.min(this.APPRECIATION_MAX, this.APPRECIATION_MONTH * held);
    const cycle = this.cyclePriceMult() / (a.purchasePriceMult ?? this.cyclePriceMult());
    return this.assetEquity(a) * appr * cycle;
  }

  /** Plusvalía latente (%) de un activo si lo vendieras hoy. */
  assetGainPct(a) {
    const eq = this.assetEquity(a);
    return eq > 0 ? Math.round((this.assetTransferValue(a) / eq - 1) * 100) : 0;
  }

  /**
   * ¿Puedo asumir la hipoteca de un activo que me traspasan? Subrogarse en un
   * préstamo consume límite de crédito igual que pedirlo de cero.
   */
  canAssumeMortgage(a) {
    if (a.financing !== 'leverage') return { ok: true };
    if (a.financials.mortgage_available > this.creditLimit()) {
      return { ok: false, reason: 'Tu límite de crédito no cubre la hipoteca que asumirías' };
    }
    return { ok: true };
  }

  /** Incorpora al portfolio un activo adquirido fuera del Marketplace (traspaso P2P). */
  acquireAsset(asset, financing, tag = 'p2p') {
    this.spendAction();
    const instance = {
      ...asset,
      financing,
      instanceId: `${asset.id}#${tag}${++this._seq}`,
      purchasedMonth: this.month,
    };
    delete instance.cell; delete instance.citySprite;
    instance.purchasePriceMult = this.cyclePriceMult();
    instance.yieldFactor = this.rollYieldFactor(instance);
    this.ownedAssets.push(instance);
    return instance;
  }

  /** Vende un activo por su valor de traspaso menos la fricción de la venta. */
  sellAsset(instanceId) {
    const idx = this.ownedAssets.findIndex(a => a.instanceId === instanceId);
    if (idx === -1) return { ok: false, reason: 'Activo no encontrado' };
    const a = this.ownedAssets[idx];
    const proceeds = Math.round(this.assetTransferValue(a) * 0.95); // 5% de costes de venta
    this.cash += proceeds;
    this.ownedAssets.splice(idx, 1);
    return { ok: true, proceeds };
  }

  /** Pide un préstamo de consumo (DEUDA ROJA): entra caja, resta liquidez cada mes. */
  takeConsumerLoan(amount) {
    const monthly = Math.round((amount * 1.10) / 12); // 10% coste anual, a 12 meses
    this.cash += amount;
    this.redDebts.push({
      id: `red#${++this._seq}`,
      label: `Préstamo consumo ${amount.toLocaleString('es-ES')} €`,
      balance: Math.round(amount * 1.10),
      monthly_payment: monthly,
    });
    return { ok: true };
  }

  /** Amortiza (cancela) una deuda roja pagando su saldo pendiente de golpe. */
  repayRedDebt(id) {
    const idx = this.redDebts.findIndex(d => d.id === id);
    if (idx === -1) return { ok: false, reason: 'Deuda no encontrada' };
    const d = this.redDebts[idx];
    if (this.cash < d.balance) return { ok: false, reason: 'Liquidez insuficiente' };
    this.cash -= d.balance;
    this.redDebts.splice(idx, 1);
    return { ok: true };
  }

  /* ---------------------- REFINANCIACIÓN ---------------------------- */

  refiFee(a) {
    return Math.round(a.financials.mortgage_available * this.REFI_FEE_PCT);
  }

  canRefinance(instanceId) {
    const a = this.ownedAssets.find(x => x.instanceId === instanceId);
    if (!a || a.financing !== 'leverage') return { ok: false, reason: 'No es una hipoteca' };
    if (a.refinanced) return { ok: false, reason: 'Ya refinanciada' };
    const act = this.canAct();
    if (!act.ok) return { ok: false, reason: act.reason, fee: this.refiFee(a) };
    const fee = this.refiFee(a);
    return { ok: this.cash >= fee, reason: 'Liquidez insuficiente', fee };
  }

  /** Refinancia: paga comisión, baja la cuota y fija el tipo (inmune a subidas). */
  refinanceAsset(instanceId) {
    const c = this.canRefinance(instanceId);
    if (!c.ok) return { ok: false, reason: c.reason };
    const a = this.ownedAssets.find(x => x.instanceId === instanceId);
    this.spendAction();
    this.cash -= c.fee;
    a.refinanced = true;
    a.rateLocked = true;
    a.refiFactor = 1 - this.REFI_REDUCTION;
    return { ok: true, fee: c.fee };
  }

  /* ------------------------- SOCIEDAD ------------------------------- */

  /** Ahorro fiscal mensual estimado al pasar a sociedad (para decidir). */
  incorporationBenefit() {
    if (this.taxVehicle === 'company') return 0;
    const excess = Math.max(0, this.totalPassiveIncome() - this.TAX_THRESHOLD);
    return excess * this.PERSONAL_TAX - this.COMPANY_MONTHLY;
  }

  canIncorporate() {
    if (this.taxVehicle === 'company') return { ok: false, reason: 'Ya eres sociedad' };
    const act = this.canAct();
    if (!act.ok) return { ok: false, reason: act.reason, cost: this.COMPANY_SETUP };
    return { ok: this.cash >= this.COMPANY_SETUP, reason: 'Liquidez insuficiente', cost: this.COMPANY_SETUP };
  }

  /** Constituye una sociedad: coste único, cambia el régimen fiscal. */
  incorporate() {
    const c = this.canIncorporate();
    if (!c.ok) return { ok: false, reason: c.reason };
    this.spendAction();
    this.cash -= this.COMPANY_SETUP;
    this.taxVehicle = 'company';
    return { ok: true };
  }

  /* --------------------------- EVENTOS ------------------------------ */

  /** ¿Se cumple la condición 'requires' de un evento en el estado actual? */
  eventConditionMet(e) {
    if (!e.requires) return true;
    if (e.requires === 'vehicle') return !!this.vehicle;         // solo si tienes coche
    if (e.requires === 'no_vehicle') return !this.vehicle;
    if (e.requires === 'real_estate') return this.ownedAssets.some(a => a.category === 'real_estate');
    return true;
  }

  /** Elige un evento aleatorio ponderado (respeta minMonth, once y requires). */
  pickEvent() {
    if (!this.events.length) return null;
    const pool = this.events.filter(e =>
      !(e.minMonth && this.month < e.minMonth) &&
      !(e.once && this.firedOnce.has(e.id)) &&
      this.eventConditionMet(e));
    const list = pool.length ? pool : this.events.filter(e => this.eventConditionMet(e));
    const total = list.reduce((s, e) => s + (e.weight || 1), 0);
    let r = Math.random() * total;
    for (const e of list) {
      r -= (e.weight || 1);
      if (r <= 0) return e;
    }
    return list[list.length - 1];
  }

  /** ¿Este evento requiere que el jugador elija (dilema)? */
  isDilemma(ev) { return ev && ev.type === 'dilemma'; }

  /** Elección automática de dilema (bots / modo auto): prioriza el bienestar bajo. */
  autoDilemmaChoice(ev) {
    if (!ev || !ev.choices) return 0;
    // si el bienestar está bajo, elige la opción que más felicidad/energía dé
    if (this.happiness < 40 || this.energy < 35) {
      let best = 0, bestScore = -Infinity;
      ev.choices.forEach((c, i) => {
        const score = (c.happiness || 0) + (c.energy || 0);
        if (score > bestScore) { bestScore = score; best = i; }
      });
      return best;
    }
    // si no, elige la que más aporte a la economía (cash + salaryBoost*grande)
    let best = 0, bestScore = -Infinity;
    ev.choices.forEach((c, i) => {
      const score = (c.cash || 0) + (c.salaryBoost || 0) * 20000;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  /** Aplica los efectos de bienestar/sueldo de un objeto {happiness,energy,salaryBoost}. */
  _applyWellbeingEffects(o) {
    if (!o) return;
    if (o.happiness) this.happiness += o.happiness;
    if (o.energy) this.energy += o.energy;
    if (o.salaryBoost) this.salaryBoost += o.salaryBoost;
    this._clampWellbeing();
  }

  /**
   * Aplica el efecto de un evento a la liquidación de ESTE mes.
   * @param {number|null} choiceIndex  para dilemas: opción elegida (o auto si null)
   * @returns ajuste { cashDelta, incomeDelta, _choice? }
   */
  applyEvent(ev, choiceIndex = null) {
    const adj = { cashDelta: 0, incomeDelta: 0 };
    if (!ev) return adj;
    if (ev.once && this.firedOnce.has(ev.id)) return adj; // hito único ya ocurrido

    switch (ev.type) {
      case 'neutral':
        break;
      case 'mortgage_cost_pct':
        this.mortgageModifier = Math.max(0.5, this.mortgageModifier * (1 + ev.value));
        break;
      case 'one_time_expense':
        adj.cashDelta -= ev.value;
        break;
      case 'one_time_income':
        adj.cashDelta += ev.value;
        break;
      case 'life':
        // evento de vida: value puede ser negativo (coste) o positivo (ingreso)
        adj.cashDelta += ev.value || 0;
        break;
      case 'dilemma': {
        const idx = choiceIndex == null ? this.autoDilemmaChoice(ev) : choiceIndex;
        const choice = ev.choices[idx];
        if (choice) {
          adj.cashDelta += choice.cash || 0;
          this._applyWellbeingEffects(choice);
          adj._choice = choice.label;
        }
        break;
      }
      case 'vacancy_real_estate': {
        const re = this.ownedAssets.filter(a => a.category === 'real_estate');
        if (re.length) {
          const hit = re[Math.floor(Math.random() * re.length)];
          adj.incomeDelta -= hit.financials.gross_monthly_income;
          adj._vacancyAsset = hit.title;
        }
        break;
      }
      case 'sector_bonus': {
        const bonus = this.ownedAssets
          .filter(a => a.category === ev.sector)
          .reduce((s, a) => s + a.financials.gross_monthly_income * ev.value, 0);
        adj.incomeDelta += bonus;
        break;
      }
      case 'sector_zero': {
        const loss = this.ownedAssets
          .filter(a => a.category === ev.sector)
          .reduce((s, a) => s + this.assetNetIncome(a), 0);
        adj.incomeDelta -= loss;
        break;
      }
    }
    // Modo Legado: los golpes en caja escalan con la era. Los shocks de ingresos
    // (vacancia, sector a cero) ya escalan solos porque dependen del portfolio.
    if (adj.cashDelta < 0) adj.cashDelta = Math.round(adj.cashDelta * this.eraRisk);
    // efectos de bienestar de cualquier evento (los dilemas ya aplican los de su opción)
    if (ev.type !== 'dilemma') this._applyWellbeingEffects(ev);
    // hitos de vida: gasto permanente y marca de evento único
    if (ev.expenseAdd) this.lifeExpenses += ev.expenseAdd;
    if (ev.once) this.firedOnce.add(ev.id);
    return adj;
  }

  /* ------------------------- PASAR DE TURNO -------------------------- */

  /**
   * Ejecuta la liquidación del mes: sueldo + evento + cashflow.
   * @returns snapshot con el desglose para la UI.
   */
  /** Deriva mensual del bienestar: trabajo, rutina y estrés financiero. */
  applyWellbeingDrift() {
    this.energy -= this.WORK_ENERGY_DRAIN;
    let happyDelta = -this.HAPPINESS_DRIFT;
    if (this.cashCushionMonths() < 1) happyDelta -= 4;          // estrés por falta de colchón
    if (this.totalRedDebtPayment() > 0) happyDelta -= 2;        // agobio de la deuda roja
    if (this.emancipationIndex() >= 100) happyDelta += 3;       // motiva ver la meta cerca
    if (this.profile.needs_car && !this.vehicle) this.energy -= 3; // trabajo que exige coche
    this.happiness += happyDelta;
    this._clampWellbeing();
  }

  /**
   * Ejecuta la liquidación del mes: sueldo + evento + cashflow + bienestar.
   * @param {object|null} presetEvent  evento ya elegido (para dilemas del jugador)
   * @param {number|null} choiceIndex  opción del dilema elegida por el jugador
   */
  endTurn(presetEvent = null, choiceIndex = null) {
    const salary = this.rollSalary();
    const event = presetEvent || this.pickEvent();
    const adj = this.applyEvent(event, choiceIndex);

    const baseCashflow = this.netMonthlyCashflow(salary);
    const monthResult = Math.round(baseCashflow + adj.cashDelta + adj.incomeDelta);

    this.cash += monthResult;

    // deriva de bienestar del mes
    this.applyWellbeingDrift();

    // inflación: tu coste de vida sube poco a poco (~3,7%/año, más rápido cada era)
    this.expenseInflation *= this.inflationRate();

    // amortización de saldo de deudas rojas (reduce balance según cuota)
    this.redDebts.forEach(d => { d.balance = Math.max(0, d.balance - d.monthly_payment); });
    this.redDebts = this.redDebts.filter(d => d.balance > 0);

    // nuevo mes: se resetean las jugadas disponibles, el estilo de vida y los extras
    this.actionsUsed = 0;
    this.lifestyleUsed = new Set();
    this.gigsUsed = new Set();

    this.month += 1;

    // la macro avanza: puede estrenarse fase del ciclo económico
    const newPhase = this.advanceCycle();

    // el mes que empieza ya tiene su rendimiento sorteado dentro de la horquilla:
    // el dashboard enseña exactamente lo que vas a cobrar, no una media teórica
    this.rollYields();

    const snap = this.recordSnapshot({
      salary, event, adj, newPhase,
      cashflow: monthResult,
      baseCashflow,
    });
    return snap;
  }

  /* --------------------------- SNAPSHOT ----------------------------- */

  /** Métricas base compartidas por el snapshot y el status (sin efectos). */
  _metrics() {
    return {
      month: this.month,
      cash: Math.round(this.cash),
      passiveIncome: Math.round(this.totalPassiveIncome()),
      netPassiveIncome: Math.round(this.netPassiveIncome()),
      taxCost: Math.round(this.taxCost()),
      taxVehicle: this.taxVehicle,
      fixedExpenses: this.fixedExpenses(),
      greenDebt: Math.round(this.totalGreenDebtPayment()),
      redDebt: Math.round(this.totalRedDebtPayment()),
      redDebtBalance: Math.round(this.totalRedDebtBalance()),
      ie: Math.round(this.emancipationIndex() * 10) / 10,
      cushionMonths: Math.round(this.cashCushionMonths() * 10) / 10,
      assetsCount: this.ownedAssets.length,
      happiness: Math.round(this.happiness),
      energy: Math.round(this.energy),
      burnout: this.isBurnout(),
      salaryBoost: Math.round((this.salaryBoost - 1) * 100),
      vehicle: this.vehicle,
      vehicleCost: this.vehicleMonthlyCost(),
      extraRent: this.extraRent,
      gigsEnabled: this.gigsEnabled(),
      actionsLeft: this.actionsLeft(),
      actionsMax: this.actionsMax(),
      cycle: this.cyclePhase(),
      cycleLeft: this.cycleLeft,
      mode: this.mode.id,
      era: this.era,
      eraLabel: eraLabel(this.era),
      targetIE: this.winTargetIE(),
      creditLimit: this.creditLimit(),
      won: this.hasWon(),
      lost: this.hasLost(),
      lossReason: this.lossReason(),
    };
  }

  /** Registra el snapshot del mes en el historial (para la gráfica) y lo devuelve. */
  recordSnapshot(extra = {}) {
    const snap = { ...this._metrics(), ...extra };
    this.history.push({ month: snap.month, ie: snap.ie, cash: snap.cash });
    return snap;
  }

  /** Estado compacto para pintar el dashboard en cualquier momento (sin mutar). */
  status() {
    return this._metrics();
  }

  /* ------------------------ PERSISTENCIA ---------------------------- */

  /** Serializa el estado dinámico (para guardar la partida). */
  toJSON() {
    return {
      profileId: this.profile.id,
      professionId: this.professionId,
      mode: this.mode,
      extraRent: this.extraRent,
      month: this.month,
      cash: this.cash,
      ownedAssets: this.ownedAssets,
      redDebts: this.redDebts,
      mortgageModifier: this.mortgageModifier,
      taxVehicle: this.taxVehicle,
      happiness: this.happiness,
      energy: this.energy,
      salaryBoost: this.salaryBoost,
      vehicle: this.vehicle,
      expenseInflation: this.expenseInflation,
      lifeExpenses: this.lifeExpenses,
      era: this.era,
      eraRisk: this.eraRisk,
      creditBoost: this.creditBoost,
      eraStartMonth: this.eraStartMonth,
      actionsUsed: this.actionsUsed,
      cycleIndex: this.cycleIndex,
      cycleLeft: this.cycleLeft,
      firedOnce: [...this.firedOnce],
      lifestyleUsed: [...this.lifestyleUsed],
      history: this.history,
      _seq: this._seq,
    };
  }

  /** Reconstruye un motor a partir de un estado guardado. */
  static fromJSON(data, profile, events) {
    const e = new EconomyEngine(profile, events, data.mode);
    e.professionId = data.professionId || 'none';
    e.extraRent = data.extraRent ?? (data.mode && data.mode.extraRent) ?? 0;
    e.month = data.month;
    e.cash = data.cash;
    e.ownedAssets = data.ownedAssets || [];
    e.redDebts = data.redDebts || [];
    e.mortgageModifier = data.mortgageModifier ?? 1;
    e.taxVehicle = data.taxVehicle || 'personal';
    e.happiness = data.happiness ?? 70;
    e.energy = data.energy ?? 80;
    e.salaryBoost = data.salaryBoost ?? 1;
    e.vehicle = data.vehicle ?? null;
    e.expenseInflation = data.expenseInflation ?? 1;
    e.lifeExpenses = data.lifeExpenses ?? 0;
    e.era = data.era ?? 1;
    e.eraRisk = data.eraRisk ?? 1;
    e.creditBoost = data.creditBoost ?? 1;
    e.eraStartMonth = data.eraStartMonth ?? 1;
    e.actionsUsed = data.actionsUsed ?? 0;
    e.cycleIndex = data.cycleIndex ?? 3;
    e.cycleLeft = data.cycleLeft ?? 4;
    e.firedOnce = new Set(data.firedOnce || []);
    e.lifestyleUsed = new Set(data.lifestyleUsed || []);
    e.history = data.history || [];
    e._seq = data._seq || 0;
    return e;
  }
}
