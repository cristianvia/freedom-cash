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

  hasWon() {
    return this.emancipationIndex() >= WIN_IE &&
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

    // inflación: tu coste de vida sube poco a poco (~3,7%/año)
    this.expenseInflation *= 1.003;

    // amortización de saldo de deudas rojas (reduce balance según cuota)
    this.redDebts.forEach(d => { d.balance = Math.max(0, d.balance - d.monthly_payment); });
    this.redDebts = this.redDebts.filter(d => d.balance > 0);

    // nuevo mes: se resetean las acciones de estilo de vida y los trabajos extra
    this.lifestyleUsed = new Set();
    this.gigsUsed = new Set();

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
      happiness: Math.round(this.happiness),
      energy: Math.round(this.energy),
      burnout: this.isBurnout(),
      salaryBoost: Math.round((this.salaryBoost - 1) * 100),
      vehicle: this.vehicle,
      vehicleCost: this.vehicleMonthlyCost(),
      extraRent: this.extraRent,
      gigsEnabled: this.gigsEnabled(),
      mode: this.mode.id,
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
    e.firedOnce = new Set(data.firedOnce || []);
    e.lifestyleUsed = new Set(data.lifestyleUsed || []);
    e.history = data.history || [];
    e._seq = data._seq || 0;
    return e;
  }
}
