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
    this.ownedAssets = [];   // { ...asset, financing:'cash'|'leverage', instanceId }
    this.redDebts = [];      // { id, label, balance, monthly_payment }
    this.mortgageModifier = 1; // acumulado por subidas/bajadas de tipos (deuda verde)
    this.history = [];       // snapshots de IE por mes (para la gráfica)
    this._seq = 0;

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

  /** Renta pasiva neta de un activo según su forma de financiación. */
  assetNetIncome(a) {
    const f = a.financials;
    if (a.financing === 'leverage') {
      // cuota afectada por el modificador de tipos acumulado
      const mortgage = f.monthly_mortgage_cost * this.mortgageModifier;
      return f.gross_monthly_income - f.maintenance_and_taxes - mortgage;
    }
    // pagado al contado: no hay hipoteca
    return f.gross_monthly_income - f.maintenance_and_taxes;
  }

  /** Suma de rentas pasivas netas de todo el portfolio. */
  totalPassiveIncome() {
    return this.ownedAssets.reduce((s, a) => s + this.assetNetIncome(a), 0);
  }

  /* ---------------------------- DEUDAS ------------------------------ */

  totalGreenDebtPayment() {
    return this.ownedAssets
      .filter(a => a.financing === 'leverage')
      .reduce((s, a) => s + a.financials.monthly_mortgage_cost * this.mortgageModifier, 0);
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

  /** Indicador de Emancipación (%). Deuda roja penaliza el denominador. */
  emancipationIndex() {
    const denom = this.fixedExpenses() + this.totalRedDebtPayment();
    if (denom <= 0) return 0;
    return (this.totalPassiveIncome() / denom) * 100;
  }

  /** Cashflow neto del mes (lo que entra realmente a caja). */
  netMonthlyCashflow(salary) {
    const income = salary + this.totalPassiveIncome();
    const outflow = this.fixedExpenses() + this.totalGreenDebtPayment() + this.totalRedDebtPayment();
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
    const monthResult = baseCashflow + adj.cashDelta + adj.incomeDelta;

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

  recordSnapshot(extra = {}) {
    const snap = {
      month: this.month,
      cash: Math.round(this.cash),
      passiveIncome: Math.round(this.totalPassiveIncome()),
      fixedExpenses: this.fixedExpenses(),
      greenDebt: Math.round(this.totalGreenDebtPayment()),
      redDebt: Math.round(this.totalRedDebtPayment()),
      redDebtBalance: Math.round(this.totalRedDebtBalance()),
      ie: Math.round(this.emancipationIndex() * 10) / 10,
      cushionMonths: Math.round(this.cashCushionMonths() * 10) / 10,
      won: this.hasWon(),
      lost: this.hasLost(),
      ...extra,
    };
    this.history.push({ month: snap.month, ie: snap.ie, cash: snap.cash });
    return snap;
  }

  /** Estado compacto para pintar el dashboard en cualquier momento. */
  status() {
    return this.recordSnapshotReadOnly();
  }

  recordSnapshotReadOnly() {
    return {
      month: this.month,
      cash: Math.round(this.cash),
      passiveIncome: Math.round(this.totalPassiveIncome()),
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
}
