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

export const WIN_IE = 120;          // Indicador de Emancipación objetivo (%)
export const WIN_MONTHS_CUSHION = 6; // colchón de tesorería (meses de gastos)

export class EconomyEngine {
  /**
   * @param {object} profile  ficha de vida (de profiles.json)
   * @param {object[]} events  lista de eventos (de events.json)
   */
  constructor(profile, events = []) {
    this.profile = profile;
    this.events = events;

    this.month = 1;
    this.cash = profile.starting_cash;
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

    this.recordSnapshot();
  }

  /* ---------------------------- INGRESOS ---------------------------- */

  /** Sueldo del mes (aplica varianza si el perfil es variable). */
  rollSalary() {
    const { salary_base, salary_variance } = this.profile;
    if (!salary_variance) return salary_base;
    const delta = (Math.random() * 2 - 1) * salary_variance;
    return Math.round(salary_base + delta);
  }

  /** Cuota hipotecaria efectiva de un activo (tipos + refinanciación). */
  mortgageCostOf(a) {
    if (a.financing !== 'leverage') return 0;
    // un activo refinanciado fija su tipo (inmune a subidas) y baja la cuota
    const rate = a.rateLocked ? 1 : this.mortgageModifier;
    return a.financials.monthly_mortgage_cost * rate * (a.refiFactor ?? 1);
  }

  /** Renta pasiva neta de un activo (bruto - mantenimiento - hipoteca efectiva). */
  assetNetIncome(a) {
    const f = a.financials;
    return f.gross_monthly_income - f.maintenance_and_taxes - this.mortgageCostOf(a);
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
    return this.profile.fixed_expenses;
  }

  /** Indicador de Emancipación (%). Usa renta pasiva tras impuestos. */
  emancipationIndex() {
    const denom = this.fixedExpenses() + this.totalRedDebtPayment();
    if (denom <= 0) return 0;
    return (this.netPassiveIncome() / denom) * 100;
  }

  /** Cashflow neto del mes (lo que entra realmente a caja). */
  netMonthlyCashflow(salary) {
    // netPassiveIncome() YA descuenta hipotecas (dentro de assetNetIncome) e
    // impuestos (taxCost). Solo restamos gastos fijos y cuotas de deuda roja.
    const income = salary + this.netPassiveIncome();
    const outflow = this.fixedExpenses() + this.totalRedDebtPayment();
    return income - outflow;
  }

  cashCushionMonths() {
    const fx = this.fixedExpenses();
    return fx > 0 ? this.cash / fx : 0;
  }

  hasWon() {
    return this.emancipationIndex() >= WIN_IE &&
           this.cash >= WIN_MONTHS_CUSHION * this.fixedExpenses();
  }

  hasLost() {
    // insolvencia: caja muy negativa sin capacidad de cubrir el mes
    return this.cash < -3000;
  }

  /* --------------------------- ACCIONES ----------------------------- */

  /**
   * ¿Puede el jugador permitirse comprar este activo con la financiación dada?
   * @returns {{ok:boolean, reason?:string, cost:number}}
   */
  canBuy(asset, financing) {
    const f = asset.financials;
    if (financing === 'leverage') {
      if (!asset.leverage_allowed) return { ok: false, reason: 'Sin apalancamiento disponible', cost: f.total_price };
      if (f.mortgage_available > this.profile.credit_limit) {
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

    this.cash -= check.cost;
    const instance = {
      ...asset,
      financing,
      instanceId: `${asset.id}#${++this._seq}`,
      purchasedMonth: this.month,
    };
    this.ownedAssets.push(instance);
    return { ok: true, instance };
  }

  /** Vende un activo por su valor neto de capital (precio - deuda pendiente aprox.). */
  sellAsset(instanceId) {
    const idx = this.ownedAssets.findIndex(a => a.instanceId === instanceId);
    if (idx === -1) return { ok: false, reason: 'Activo no encontrado' };
    const a = this.ownedAssets[idx];
    const f = a.financials;
    // equity aproximada: contado -> precio total; apalancado -> entrada (capital aportado)
    const equity = a.financing === 'leverage' ? f.down_payment_required : f.total_price;
    this.cash += Math.round(equity * 0.95); // 5% de fricción/costes de venta
    this.ownedAssets.splice(idx, 1);
    return { ok: true, proceeds: Math.round(equity * 0.95) };
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
    const fee = this.refiFee(a);
    return { ok: this.cash >= fee, reason: 'Liquidez insuficiente', fee };
  }

  /** Refinancia: paga comisión, baja la cuota y fija el tipo (inmune a subidas). */
  refinanceAsset(instanceId) {
    const c = this.canRefinance(instanceId);
    if (!c.ok) return { ok: false, reason: c.reason };
    const a = this.ownedAssets.find(x => x.instanceId === instanceId);
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
    return { ok: this.cash >= this.COMPANY_SETUP, reason: 'Liquidez insuficiente', cost: this.COMPANY_SETUP };
  }

  /** Constituye una sociedad: coste único, cambia el régimen fiscal. */
  incorporate() {
    const c = this.canIncorporate();
    if (!c.ok) return { ok: false, reason: c.reason };
    this.cash -= this.COMPANY_SETUP;
    this.taxVehicle = 'company';
    return { ok: true };
  }

  /* --------------------------- EVENTOS ------------------------------ */

  /** Elige un evento aleatorio ponderado por weight. */
  pickEvent() {
    if (!this.events.length) return null;
    const total = this.events.reduce((s, e) => s + (e.weight || 1), 0);
    let r = Math.random() * total;
    for (const e of this.events) {
      r -= (e.weight || 1);
      if (r <= 0) return e;
    }
    return this.events[this.events.length - 1];
  }

  /**
   * Aplica el efecto de un evento a la liquidación de ESTE mes.
   * Devuelve un ajuste { cashDelta, incomeDelta } que se suma al cashflow.
   * Los efectos permanentes (tipos) modifican mortgageModifier.
   */
  applyEvent(ev) {
    const adj = { cashDelta: 0, incomeDelta: 0 };
    if (!ev) return adj;

    switch (ev.type) {
      case 'neutral':
        break;
      case 'mortgage_cost_pct':
        // efecto permanente sobre las cuotas hipotecarias (deuda verde)
        this.mortgageModifier = Math.max(0.5, this.mortgageModifier * (1 + ev.value));
        break;
      case 'one_time_expense':
        adj.cashDelta -= ev.value;
        break;
      case 'one_time_income':
        adj.cashDelta += ev.value;
        break;
      case 'vacancy_real_estate': {
        const re = this.ownedAssets.filter(a => a.category === 'real_estate');
        if (re.length) {
          const hit = re[Math.floor(Math.random() * re.length)];
          adj.incomeDelta -= hit.financials.gross_monthly_income; // pierde renta bruta este mes
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
        adj.incomeDelta -= loss; // este mes ese sector no aporta
        break;
      }
    }
    return adj;
  }

  /* ------------------------- PASAR DE TURNO -------------------------- */

  /**
   * Ejecuta la liquidación del mes: sueldo + evento + cashflow.
   * @returns snapshot con el desglose para la UI.
   */
  endTurn() {
    const salary = this.rollSalary();
    const event = this.pickEvent();
    const adj = this.applyEvent(event);

    const baseCashflow = this.netMonthlyCashflow(salary);
    const monthResult = Math.round(baseCashflow + adj.cashDelta + adj.incomeDelta);

    this.cash += monthResult;

    // amortización de saldo de deudas rojas (reduce balance según cuota)
    this.redDebts.forEach(d => { d.balance = Math.max(0, d.balance - d.monthly_payment); });
    this.redDebts = this.redDebts.filter(d => d.balance > 0);

    this.month += 1;
    const snap = this.recordSnapshot({
      salary, event, adj,
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
      won: this.hasWon(),
      lost: this.hasLost(),
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
      month: this.month,
      cash: this.cash,
      ownedAssets: this.ownedAssets,
      redDebts: this.redDebts,
      mortgageModifier: this.mortgageModifier,
      taxVehicle: this.taxVehicle,
      history: this.history,
      _seq: this._seq,
    };
  }

  /** Reconstruye un motor a partir de un estado guardado. */
  static fromJSON(data, profile, events) {
    const e = new EconomyEngine(profile, events);
    e.month = data.month;
    e.cash = data.cash;
    e.ownedAssets = data.ownedAssets || [];
    e.redDebts = data.redDebts || [];
    e.mortgageModifier = data.mortgageModifier ?? 1;
    e.taxVehicle = data.taxVehicle || 'personal';
    e.history = data.history || [];
    e._seq = data._seq || 0;
    return e;
  }
}
