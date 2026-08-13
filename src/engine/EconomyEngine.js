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

/* --- Modo Legado: al ganar encadenas "eras", y no se acaban nunca --- */
export const ERA_IE_STEP = 0.20;    // el listón de IE sube un 20% por era
export const ERA_RISK_STEP = 1.18;  // los eventos negativos pegan un 18% más fuerte
export const ERA_CREDIT_STEP = 1.5; // tu límite de crédito crece un 50%
export const ERA_ASSET_STEP = 1.40; // el mercado ofrece activos ~40% mayores por era
export const ERA_LIFE_COST = 0.12;  // suelo mínimo de subida del coste de vida

/**
 * La clave del espaciado. Al estrenar era, tu nivel de vida sube hasta dejar tu
 * IE en esta fracción del nuevo objetivo: la libertad que ya tenías cubre poco
 * más de la mitad de la vida que ahora llevas. Es el "lifestyle creep" real —
 * y es lo que hace que cada era cueste trabajo en vez de regalarse.
 */
export const ERA_START_RATIO = 0.55;

/** Nombres narrativos. Al agotarlos se reciclan con numeral: "Leyenda II". */
export const ERA_NAMES = [
  'Emancipación', 'Consolidación', 'Expansión', 'Patrimonio', 'Imperio',
  'Legado', 'Dinastía', 'Mecenazgo', 'Leyenda',
];

const ROMAN = ['', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** Nombre de una era, sin techo: 'Expansión', 'Leyenda II', 'Imperio III'… */
export function eraName(era) {
  const n = ERA_NAMES.length;
  const base = ERA_NAMES[(era - 1) % n];
  const loop = Math.floor((era - 1) / n);
  return loop ? `${base} ${ROMAN[loop] || `×${loop + 1}`}` : base;
}

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
  return `Era ${era} · ${eraName(era)}`;
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

    /*
     * Los tipos se mueven, pero no se van para siempre. Antes el modificador
     * era un producto sin techo: unas cuantas subidas encadenadas lo dejaban en
     * ×7 y TODA tu cartera apalancada pasaba a cashflow negativo sin remedio,
     * porque refinanciar cuesta una acción y no hay acciones para 300 activos.
     * Ahora vive en una horquilla y cada mes tira de vuelta hacia el 1,0.
     */
    this.RATE_MIN = 0.6;        // suelo: una hipoteca nunca sale casi gratis
    this.RATE_MAX = 1.8;        // techo: ni cuesta nunca el doble de lo firmado
    this.RATE_REVERSION = 0.02; // fracción del camino de vuelta a 1,0 cada mes
    this.history = [];       // snapshots de IE por mes (para la gráfica)
    this._seq = 0;

    // --- Estructura fiscal: 'personal' → 'company' → 'holding' → 'socimi' ---
    this.taxVehicle = 'personal';
    this.taxData = null;        // se inyecta con setTaxData() (tax.json)
    // compat con partidas guardadas y con la UI antigua
    this.COMPANY_SETUP = 4000;
    this.COMPANY_MONTHLY = 220;

    // --- Refinanciación de hipotecas ---
    this.REFI_FEE_PCT = 0.03;   // comisión (sobre la hipoteca) por refinanciar
    this.REFI_REDUCTION = 0.25; // reducción de la cuota tras refinanciar

    // --- Seguros: pagar todos los meses para que un mal mes no te hunda ---
    this.insurance = new Set();
    this.insuranceData = null;

    // --- Ventas en curso: no todo se vende el mismo día ---
    this.pendingSales = [];

    // --- Due diligence: investigar antes de firmar ---
    this.investigated = new Set();   // ids de activos ya analizados
    this.DD_PCT = 0.012;             // coste del análisis (% del precio)
    this.DD_MIN = 200;

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

    // --- Fusión de activos: crecer hacia arriba, no solo a lo ancho ---
    this.MERGE_NEED = 3;   // ejemplares iguales que hacen falta para subir de escalón

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

  /* ------------------------ TIPOS DE INTERÉS ------------------------ */

  /** Encierra el modificador de tipos en su horquilla. */
  clampRate(v) { return Math.min(this.RATE_MAX, Math.max(this.RATE_MIN, v)); }

  /**
   * Reversión a la media: cada mes el tipo recorre una fracción del camino de
   * vuelta al 1,0. Un ciclo de subidas sigue doliendo —y mucho— pero se acaba
   * pasando, así que aguantar es una jugada en vez de una condena.
   */
  applyRateReversion() {
    this.mortgageModifier = this.clampRate(
      this.mortgageModifier + (1 - this.mortgageModifier) * this.RATE_REVERSION);
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

  /* ------------------------- INDEXACIÓN ----------------------------- */
  /*
   * La mitad silenciosa del juego contra la inflación. Antes tus gastos subían
   * y tus rentas se quedaban clavadas en el euro del día que compraste, así que
   * cualquier activo de hace tres eras acababa siendo calderilla. Ahora cada
   * activo declara cómo se actualiza:
   *
   *   ipc      el alquiler se revisa cada año (inmuebles). También sus gastos.
   *   market   sigue al mercado a medias (fondos, REIT, cripto).
   *   none     nominal puro (bonos, monetario, negocios sin reinvertir).
   *
   * La cuota de la hipoteca NO se actualiza nunca: por eso la deuda a tipo fijo
   * es un activo cuando los precios suben, que es la lección de verdad.
   */

  /** Cuánto ha subido el coste de vida desde que compraste este activo. */
  inflationSince(a) {
    return this.expenseInflation / (a.purchaseInflation || 1);
  }

  /** Factor de actualización de la renta de un activo. */
  indexationFactor(a) {
    const mode = a.indexation || 'none';
    if (mode === 'none') return 1;
    const since = this.inflationSince(a);
    return mode === 'ipc' ? since : Math.pow(since, 0.6);
  }

  /** Gastos de mantenimiento de hoy: lo que se revisa, se revisa también aquí. */
  maintenanceOf(a) {
    const idx = a.indexation === 'ipc' || a.indexation === 'market'
      ? this.indexationFactor(a) : 1;
    return a.financials.maintenance_and_taxes * idx;
  }

  /** Renta bruta del mes: catálogo × indexación × despegues × ciclo × horquilla. */
  grossIncomeOf(a) {
    if (a.ruined) return 0;   // se fue a cero: sigue en la ciudad, pero no paga
    const boom = Math.pow(1.4, a.boomed || 0);
    return a.financials.gross_monthly_income * this.indexationFactor(a) * boom *
      this.cycleYieldMult() * (a.yieldFactor ?? 1);
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
    const fixed = this.maintenanceOf(a) + this.mortgageCostOf(a);
    const gross = f.gross_monthly_income * this.indexationFactor(a) *
      Math.pow(1.4, a.boomed || 0) * this.cycleYieldMult();
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
    const d = this.districtBonus(a.category);   // economías de escala del distrito
    return this.grossIncomeOf(a) * d.gross
      - this.maintenanceOf(a) * d.maint
      - this.mortgageCostOf(a);
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
  /*
   * Los impuestos son la mitad del juego de las finanzas, así que aquí no hay
   * un porcentaje mágico: hay una escalera de estructuras reales (persona
   * física → SL → holding → SOCIMI), base imponible con amortizaciones
   * deducibles, y un asesor que dice cuándo compensa dar el salto.
   */

  /** Inyecta el catálogo fiscal (tax.json). Sin él se usa un IRPF simplificado. */
  setTaxData(data) { this.taxData = data; }

  /** Todas las estructuras disponibles, en orden de escalera. */
  taxStructures() { return (this.taxData && this.taxData.structures) || []; }

  taxStructure(id = this.taxVehicle) {
    return this.taxStructures().find(s => s.id === id) || null;
  }

  /** Peldaño actual (0 = persona física). */
  taxTier(id = this.taxVehicle) {
    const i = this.taxStructures().findIndex(s => s.id === id);
    return i < 0 ? 0 : i;
  }

  /**
   * Amortización mensual deducible: solo la construcción (~70% del precio) se
   * amortiza, al 3% anual. Es gasto sin salida de caja — la razón fiscal de que
   * el ladrillo sea tan eficiente.
   */
  monthlyAmortization() {
    const cfg = (this.taxData && this.taxData.amortization) || { building_share: 0.7, annual_rate: 0.03 };
    return this.ownedAssets
      .filter(a => a.category === 'real_estate')
      .reduce((s, a) => s + a.financials.total_price * cfg.building_share * cfg.annual_rate / 12, 0);
  }

  /**
   * Base imponible mensual partida en dos, como en el IRPF real:
   *  - general: alquileres y negocios (escala hasta el 47%)
   *  - ahorro: dividendos y plusvalías (escala 19-30%)
   * Las amortizaciones descuentan de la general, que es donde están los pisos.
   */
  taxableBaseSplit() {
    const savingsCats = (this.taxData && this.taxData.savings_categories) || ['financial'];
    let general = 0, savings = 0;
    this.ownedAssets.forEach(a => {
      const net = this.assetNetIncome(a);
      if (savingsCats.includes(a.category)) savings += net; else general += net;
    });
    return {
      general: Math.max(0, general - this.monthlyAmortization()),
      savings: Math.max(0, savings),
    };
  }

  /** Base imponible total del mes (lo que se enseña en el dashboard). */
  taxableBase() {
    const b = this.taxableBaseSplit();
    return b.general + b.savings;
  }

  /** Cuota mensual de IRPF sobre una renta mensual, por tramos anuales. */
  irpfOn(monthlyBase, scale = 'general') {
    const key = scale === 'savings' ? 'irpf_savings_annual' : 'irpf_general_annual';
    const brackets = (this.taxData && this.taxData[key]) || [{ upTo: null, rate: 0.25 }];
    let annual = Math.max(0, monthlyBase) * 12;
    let prev = 0, due = 0;
    for (const b of brackets) {
      const top = b.upTo == null ? Infinity : b.upTo;
      const slice = Math.max(0, Math.min(annual, top) - prev);
      due += slice * b.rate;
      prev = top;
      if (annual <= top) break;
    }
    return due / 12;
  }

  /** Coste fiscal mensual de una estructura concreta con TU situación actual. */
  taxCostFor(id) {
    const s = this.taxStructure(id);
    const split = this.taxableBaseSplit();
    const base = split.general + split.savings;
    if (!s) {
      // sin datos cargados: IRPF plano de respaldo
      return Math.max(0, base - 2000) * 0.25;
    }
    // persona física: cada base por su escala, tras el mínimo personal exento
    if (s.kind === 'irpf') {
      const allowance = ((this.taxData && this.taxData.personal_allowance_annual) || 0) / 12;
      const general = Math.max(0, split.general - allowance);
      const savings = Math.max(0, split.savings - Math.max(0, allowance - split.general));
      return this.irpfOn(general, 'general') + this.irpfOn(savings, 'savings');
    }
    // sociedades: tipo fijo sobre la base tras gastos deducibles + coste fijo
    return base * (1 - (s.baseCut || 0)) * (s.rate || 0) + (s.monthly || 0);
  }

  /** Coste fiscal mensual de la estructura vigente. */
  taxCost() { return this.taxCostFor(this.taxVehicle); }

  /** Tipo efectivo (%) que estás pagando sobre tu renta pasiva. */
  effectiveTaxRate() {
    const gross = this.totalPassiveIncome();
    return gross > 0 ? (this.taxCost() / gross) * 100 : 0;
  }

  /** ¿Cumples los requisitos para constituir esta estructura? */
  taxRequirementsMet(id) {
    const s = this.taxStructure(id);
    if (!s) return { ok: false, reason: 'Estructura desconocida' };
    const req = s.requires || {};
    if (req.structure && this.taxTier() < this.taxTier(req.structure)) {
      const prev = this.taxStructure(req.structure);
      return { ok: false, reason: `Antes necesitas constituir la ${prev ? prev.label : req.structure}` };
    }
    if (req.passiveIncome && this.totalPassiveIncome() < req.passiveIncome) {
      return { ok: false, reason: `Necesitas ${Math.round(req.passiveIncome).toLocaleString('es-ES')} €/mes de renta pasiva` };
    }
    if (req.realEstateAssets) {
      const n = this.ownedAssets.filter(a => a.category === 'real_estate').length;
      if (n < req.realEstateAssets) {
        return { ok: false, reason: `Necesitas ${req.realEstateAssets} inmuebles (tienes ${n})` };
      }
    }
    return { ok: true };
  }

  /** ¿Puedes dar el salto a esta estructura ahora mismo? */
  canAdoptTax(id) {
    if (id === this.taxVehicle) return { ok: false, reason: 'Ya es tu estructura actual' };
    if (this.taxTier(id) < this.taxTier()) return { ok: false, reason: 'No se puede bajar de estructura' };
    const req = this.taxRequirementsMet(id);
    if (!req.ok) return req;
    const act = this.canAct();
    if (!act.ok) return { ok: false, reason: act.reason };
    const cost = (this.taxStructure(id) || {}).setup || 0;
    return { ok: this.cash >= cost, reason: 'Liquidez insuficiente para la constitución', cost };
  }

  /** Constituye la estructura: paga el coste único y cambia de régimen. */
  adoptTax(id) {
    const c = this.canAdoptTax(id);
    if (!c.ok) return { ok: false, reason: c.reason };
    this.spendAction();
    this.cash -= c.cost;
    this.taxVehicle = id;
    return { ok: true, cost: c.cost, structure: this.taxStructure(id) };
  }

  /**
   * El asesor fiscal: compara todas las estructuras con TU renta de hoy y dice
   * cuál es la óptima, cuánto ahorrarías y, si aún no compensa, qué falta.
   */
  taxAdvice() {
    const list = this.taxStructures();
    if (!list.length) return null;
    const current = this.taxCost();
    const options = list.map(s => {
      const req = this.taxRequirementsMet(s.id);
      const cost = this.taxCostFor(s.id);
      return {
        structure: s,
        monthlyCost: cost,
        saving: current - cost,               // €/mes que te ahorrarías
        eligible: req.ok,
        blockedBy: req.ok ? null : req.reason,
        setup: s.setup || 0,
        // meses en recuperar el coste de constitución
        payback: current - cost > 0 ? Math.ceil((s.setup || 0) / (current - cost)) : null,
        isCurrent: s.id === this.taxVehicle,
      };
    });
    // el mejor movimiento: el que más ahorra, sea alcanzable y se amortice
    const best = options
      .filter(o => !o.isCurrent && o.eligible && o.saving > 0 && o.payback != null && o.payback <= 36)
      .sort((a, b) => b.saving - a.saving)[0] || null;
    // el siguiente peldaño aunque todavía no llegues (para saber a qué aspirar)
    const next = options.find(o => this.taxTier(o.structure.id) === this.taxTier() + 1) || null;
    return { options, best, next, current };
  }

  /* --- compat: la UI y la IA antiguas hablaban solo de "sociedad" --- */

  /** Ahorro mensual estimado al pasar al siguiente peldaño recomendado. */
  incorporationBenefit() {
    const adv = this.taxAdvice();
    return adv && adv.best ? adv.best.saving : 0;
  }

  canIncorporate() {
    const adv = this.taxAdvice();
    if (!adv || !adv.best) return { ok: false, reason: 'Ninguna estructura te compensa todavía' };
    return this.canAdoptTax(adv.best.structure.id);
  }

  /** Adopta la estructura que recomiende el asesor. */
  incorporate() {
    const adv = this.taxAdvice();
    if (!adv || !adv.best) return { ok: false, reason: 'Ninguna estructura te compensa todavía' };
    return this.adoptTax(adv.best.structure.id);
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

  /**
   * Indicador de Emancipación (%). El coche y los seguros suben tu listón de
   * libertad: todo lo que pagas cada mes es vida que tus activos deben cubrir.
   */
  emancipationIndex() {
    const denom = this.fixedExpenses() + this.vehicleMonthlyCost() +
      this.insuranceMonthlyCost() + this.totalRedDebtPayment();
    if (denom <= 0) return 0;
    return (this.netPassiveIncome() / denom) * 100;
  }

  /** Cashflow neto del mes (lo que entra realmente a caja). */
  netMonthlyCashflow(salary) {
    // netPassiveIncome() YA descuenta hipotecas (dentro de assetNetIncome) e
    // impuestos (taxCost). Restamos gastos fijos, coste del coche y deuda roja.
    const income = salary + this.netPassiveIncome();
    const outflow = this.fixedExpenses() + this.vehicleMonthlyCost() +
      this.insuranceMonthlyCost() + this.totalRedDebtPayment();
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

  /**
   * Inflación mensual: se acelera con la era, pero con techo. Sin el tope, a
   * partir de la era 8 el suelo corría más que cualquier cartera y el Modo
   * Legado se volvía imposible en vez de largo.
   */
  inflationRate() {
    const accel = Math.min(2.5, 1 + 0.25 * (this.era - 1));
    return 1 + (this.INFLATION_BASE - 1) * accel;
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
    this.eraRisk = Math.min(3, this.eraRisk * ERA_RISK_STEP);   // con techo: exigente, no imposible
    this.creditBoost *= ERA_CREDIT_STEP;

    // Tu nivel de vida sube contigo. No un porcentaje simbólico: sube hasta que
    // la renta pasiva que ya tienes solo cubra ERA_START_RATIO del nuevo listón.
    // Sin esto, cada era se ganaba en 3-6 meses porque llegabas con los deberes
    // hechos; con esto, cada era es una partida de verdad a su escala.
    const target = this.winTargetIE() * ERA_START_RATIO;         // IE con el que arrancas
    const denomNow = this.fixedExpenses() + this.vehicleMonthlyCost() + this.totalRedDebtPayment();
    const denomWanted = this.netPassiveIncome() / (target / 100);
    const floor = Math.round(this.profile.fixed_expenses * ERA_LIFE_COST);
    const lifeAdd = Math.max(floor, Math.round(denomWanted - denomNow));
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

  /** Descubierto que aguanta el banco antes de declararte insolvente. */
  insolvencyLimit() {
    return -Math.max(3000, this.fixedExpenses());   // escala con tu tamaño
  }

  hasLost() {
    // insolvencia (caja muy negativa) o abandono (felicidad agotada)
    return this.cash < this.insolvencyLimit() || this.happiness <= 0;
  }

  lossReason() {
    if (this.happiness <= 0) return 'abandono';
    if (this.cash < this.insolvencyLimit()) return 'insolvencia';
    return null;
  }

  /* --------------------------- ACCIONES ----------------------------- */

  /**
   * ¿Puede este activo salir en el mercado para mí? Universal o de mi
   * profesión, y nunca los escalones de fusión: a esos se llega reagrupando,
   * que es justo lo que les da sentido.
   */
  assetEligible(asset) {
    if (asset.merge_only) return false;
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
      purchaseInflation: this.expenseInflation,
    };
    instance.yieldFactor = this.rollYieldFactor(instance);  // ya renta dentro de su horquilla
    this.ownedAssets.push(instance);
    return { ok: true, instance };
  }

  /* ---------------------------- SEGUROS ----------------------------- */
  /*
   * La otra mitad de la gestión del riesgo. No dan rentabilidad: quitan cola de
   * pérdidas. Y como su cuota entra en tus gastos fijos, protegerte SUBE tu
   * listón de libertad — que es exactamente el dilema real.
   */

  setInsuranceData(data) { this.insuranceData = data; }

  insurancePolicies() { return (this.insuranceData && this.insuranceData.policies) || []; }

  hasInsurance(id) { return this.insurance.has(id); }

  insuranceMonthlyCost() {
    return this.insurancePolicies()
      .filter(p => this.insurance.has(p.id))
      .reduce((s, p) => s + p.monthly, 0);
  }

  /** Fracción del golpe que absorben tus pólizas (con tope). */
  insuranceCoverage() {
    const max = (this.insuranceData && this.insuranceData.max_coverage) || 0.8;
    const sum = this.insurancePolicies()
      .filter(p => this.insurance.has(p.id))
      .reduce((s, p) => s + p.coverage, 0);
    return Math.min(max, sum);
  }

  /** Contrata o cancela una póliza. Contratar cuesta una acción. */
  toggleInsurance(id) {
    const p = this.insurancePolicies().find(x => x.id === id);
    if (!p) return { ok: false, reason: 'Póliza desconocida' };
    if (this.insurance.has(id)) { this.insurance.delete(id); return { ok: true, active: false, policy: p }; }
    const act = this.canAct();
    if (!act.ok) return { ok: false, reason: act.reason };
    this.spendAction();
    this.insurance.add(id);
    return { ok: true, active: true, policy: p };
  }

  /* ----------------------- SINERGIAS DE DISTRITO -------------------- */
  /*
   * Concentrar activos de la misma categoría da economías de escala: un mismo
   * gestor, un mismo proveedor, un mismo contrato marco. La ciudad isométrica
   * deja de ser decorado y pasa a ser una decisión.
   */

  categoryCount(cat) {
    return this.ownedAssets.filter(a => a.category === cat && !a.ruined).length;
  }

  /** Bonus del distrito de una categoría: menos mantenimiento y algo más de renta. */
  districtBonus(cat) {
    const n = this.categoryCount(cat);
    if (n >= 8) return { maint: 0.75, gross: 1.08, tier: 3, next: null, n };
    if (n >= 5) return { maint: 0.85, gross: 1.04, tier: 2, next: 8, n };
    if (n >= 3) return { maint: 0.92, gross: 1.00, tier: 1, next: 5, n };
    return { maint: 1, gross: 1, tier: 0, next: 3, n };
  }

  /* ------------------------ LIQUIDEZ / VENTAS ----------------------- */
  /*
   * Un ETF se vende hoy; un local tarda meses en colocarse. La liquidez es una
   * dimensión del riesgo que casi ningún juego modela y que en la vida real
   * decide si sobrevives a un apuro.
   */

  /** Meses que tarda en cerrarse la venta de un activo. */
  liquidityMonths(a) {
    if (a.category === 'financial') return 0;
    if (a.category === 'digital_business') return 1;
    return 2;
  }

  /** ¿Tiene este activo una venta ya en curso? */
  isForSale(instanceId) {
    return this.pendingSales.some(s => s.instanceId === instanceId);
  }

  /** Cobra las ventas que se cierran este mes. */
  settlePendingSales() {
    const closed = [];
    this.pendingSales = this.pendingSales.filter(s => {
      s.months -= 1;
      if (s.months > 0) return true;
      this.cash += s.proceeds;
      this.ownedAssets = this.ownedAssets.filter(a => a.instanceId !== s.instanceId);
      closed.push(s);
      return false;
    });
    return closed;
  }

  /* --------------------- DUE DILIGENCE / CALIDAD -------------------- */
  /*
   * No todas las oportunidades son buenas, y algunas son directamente estafas.
   * Pero el juego nunca miente: las señales están a la vista de quien mire
   * (nadie financia un chiringuito, nadie tiene cero gastos, nadie paga el
   * triple que el mercado sin motivo). Investigar cuesta tiempo y dinero;
   * no investigar cuesta el capital entero.
   */

  /** Señales de alarma visibles SIN pagar análisis. Se deducen de la ficha. */
  assetFlags(asset) {
    const f = asset.financials;
    const flags = [];
    const invested = f.down_payment_required || f.total_price;
    const coc = invested ? (f.gross_monthly_income - f.maintenance_and_taxes - f.monthly_mortgage_cost) * 12 / invested * 100 : 0;
    if (coc > 70) flags.push('Rentabilidad muy por encima del mercado');
    if (!asset.leverage_allowed && asset.category === 'real_estate') {
      flags.push('Ningún banco quiere financiarlo');
    }
    if (!f.maintenance_and_taxes) flags.push('Declara cero gastos de mantenimiento');
    const risk = (asset.metrics && asset.metrics.vacancy_rate_risk) || 0;
    if (risk >= 0.55) flags.push('Riesgo altísimo de irse a cero');
    else if (risk >= 0.33) flags.push('Riesgo muy por encima de lo habitual');
    return flags;
  }

  dueDiligenceCost(asset) {
    return Math.max(this.DD_MIN, Math.round(asset.financials.total_price * this.DD_PCT));
  }

  isInvestigated(asset) { return this.investigated.has(asset.baseId || asset.id); }

  canInvestigate(asset) {
    if (this.isInvestigated(asset)) return { ok: false, reason: 'Ya lo has analizado' };
    const act = this.canAct();
    if (!act.ok) return { ok: false, reason: act.reason };
    const cost = this.dueDiligenceCost(asset);
    return { ok: this.cash >= cost, reason: 'Liquidez insuficiente para el análisis', cost };
  }

  /**
   * Paga un análisis independiente: destapa la naturaleza real del activo y su
   * probabilidad mensual de irse a cero (o de despegar).
   */
  investigate(asset) {
    const c = this.canInvestigate(asset);
    if (!c.ok) return { ok: false, reason: c.reason };
    this.spendAction();
    this.cash -= c.cost;
    this.investigated.add(asset.baseId || asset.id);
    const o = asset.outcome || {};
    return {
      ok: true, cost: c.cost,
      quality: asset.quality || 'solid',
      warning: asset.warning || null,
      ruin: o.ruin || 0,
      boom: o.boom || 0,
    };
  }

  /* ---------------------- RUINA Y DESPEGUE -------------------------- */

  /**
   * Resuelve el destino de los activos con riesgo real. Un chiringuito revienta
   * y se lleva TODO el capital; una apuesta legítima que sale mal deja un
   * residuo; y a veces una apuesta despega y su renta sube para siempre.
   * @returns {object[]} sucesos para contarlos en la UI
   */
  rollOutcomes() {
    const events = [];
    for (const a of [...this.ownedAssets]) {
      const o = a.outcome;
      if (!o || a.ruined) continue;
      if (o.ruin && Math.random() < o.ruin) {
        const scam = a.quality === 'scam';
        if (scam) {
          this.ownedAssets = this.ownedAssets.filter(x => x.instanceId !== a.instanceId);
        } else {
          a.ruined = true;   // sigue siendo tuyo, pero ya no renta
        }
        events.push({ type: 'ruin', scam, asset: a });
        continue;
      }
      if (o.boom && Math.random() < o.boom) {
        a.boomed = (a.boomed || 0) + 1;
        events.push({ type: 'boom', asset: a });
      }
    }
    return events;
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
    // un activo arruinado ya no vale lo que costó: solo queda el residuo
    const state = a.ruined ? 0.25 : Math.pow(1.35, a.boomed || 0);
    return this.assetEquity(a) * appr * cycle * state;
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
    instance.purchaseInflation = this.expenseInflation;
    instance.yieldFactor = this.rollYieldFactor(instance);
    this.ownedAssets.push(instance);
    return instance;
  }

  /**
   * Pone un activo a la venta por su valor de traspaso menos la fricción. Los
   * financieros se liquidan en el acto; un negocio tarda un mes y un inmueble
   * dos: hasta que cierra la venta sigue rentando, pero el dinero no está.
   */
  sellAsset(instanceId) {
    const a = this.ownedAssets.find(x => x.instanceId === instanceId);
    if (!a) return { ok: false, reason: 'Activo no encontrado' };
    if (this.isForSale(instanceId)) return { ok: false, reason: 'Ya está en venta' };
    const proceeds = Math.round(this.assetTransferValue(a) * 0.95); // 5% de costes de venta
    const months = this.liquidityMonths(a);
    if (months <= 0) {
      this.cash += proceeds;
      this.ownedAssets = this.ownedAssets.filter(x => x.instanceId !== instanceId);
      return { ok: true, proceeds, months: 0, immediate: true };
    }
    // se guarda la celda para poder derribar el edificio cuando cierre la venta
    this.pendingSales.push({ instanceId, months, proceeds, title: a.title, cell: a.cell });
    return { ok: true, proceeds, months, immediate: false };
  }

  /** Retira un activo del mercado antes de que se cierre la venta. */
  cancelSale(instanceId) {
    const before = this.pendingSales.length;
    this.pendingSales = this.pendingSales.filter(s => s.instanceId !== instanceId);
    return { ok: this.pendingSales.length < before };
  }

  /* ------------------------ FUSIÓN DE ACTIVOS ----------------------- */
  /*
   * El segundo eje del juego. Con solo comprar, la partida crece a lo ancho —el
   * trastero número 223— y todo lo viejo se queda pequeño para siempre. Aquí
   * tres ejemplares iguales se reagrupan en uno del escalón superior: renta más
   * por euro, ocupa UNA casilla de la ciudad en vez de tres, y da un objetivo a
   * pocos meses vista ("me falta un trastero para el bloque").
   *
   * El escalón se resuelve contra el catálogo de HOY, no contra el de la era en
   * que compraste: por eso tus activos viejos, que ya no movían la aguja, valen
   * como entrada para algo del tamaño actual.
   */

  /** Identificador del activo base, sin el sufijo de era. */
  baseIdOf(a) { return a.baseId || String(a.id).replace(/@e\d+$/, ''); }

  /** ¿Puede este ejemplar entrar en una fusión ahora mismo? */
  mergeable(a) {
    return !!a.upgrade && !a.ruined && !this.isForSale(a.instanceId);
  }

  /**
   * Ejemplares que pide este escalón. Los últimos peldaños piden menos: con 3
   * en todos, la cima de una cadena de cuatro exigía 27 unidades de base y no
   * la alcanzaba nadie, así que el mejor contenido no se veía nunca.
   */
  mergeNeedFor(a) { return a.merge_need || this.MERGE_NEED; }

  /**
   * Grupos con ejemplares suficientes para subir de escalón. Se gastan primero
   * los más antiguos: el sedimento de eras pasadas es justo el combustible.
   * @returns {{baseId:string, upgradeId:string, picks:object[], count:number, title:string}[]}
   */
  mergeCandidates() {
    const groups = new Map();
    this.ownedAssets.forEach(a => {
      if (!this.mergeable(a)) return;
      const k = this.baseIdOf(a);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(a);
    });
    return [...groups.entries()]
      .filter(([, list]) => list.length >= this.mergeNeedFor(list[0]))
      .map(([baseId, list]) => {
        const need = this.mergeNeedFor(list[0]);
        const sorted = [...list].sort((a, b) => (a.purchasedMonth || 0) - (b.purchasedMonth || 0));
        return {
          baseId,
          upgradeId: sorted[0].upgrade,
          need,
          picks: sorted.slice(0, need),
          count: list.length,
          title: sorted[sorted.length - 1].title,
        };
      });
  }

  /** Lo que aportan los ejemplares a fusionar: su valor de traspaso de hoy. */
  mergeContribution(picks) {
    return picks.reduce((s, a) => s + this.assetTransferValue(a), 0);
  }

  /**
   * ¿Se puede cerrar esta fusión? Devuelve lo que habría que poner encima
   * (negativo = te devuelven cambio, porque aportas de más).
   * @param {object[]} picks   ejemplares que se consumen
   * @param {object} target    activo del escalón superior, ya escalado a la era
   */
  canMerge(picks, target) {
    if (!target) return { ok: false, reason: 'Este activo no tiene escalón superior' };
    const need = picks && picks.length ? this.mergeNeedFor(picks[0]) : this.MERGE_NEED;
    if (!picks || picks.length < need) {
      return { ok: false, reason: `Necesitas ${need} ejemplares iguales` };
    }
    const act = this.canAct();
    if (!act.ok) return { ok: false, reason: act.reason, noActions: true };
    const f = this.pricedFinancials(target);
    // se entra por la vía más barata que permita el activo y tu crédito
    const lev = target.leverage_allowed && f.mortgage_available <= this.creditLimit();
    const financing = lev ? 'leverage' : 'cash';
    const entry = lev ? f.down_payment_required : f.total_price;
    const contribution = this.mergeContribution(picks);
    const extra = Math.round(entry - contribution);
    return {
      ok: this.cash >= extra,
      reason: 'Liquidez insuficiente para completar la fusión',
      extra, entry, financing,
      contribution: Math.round(contribution),
    };
  }

  /**
   * Reagrupa: los ejemplares aportados desaparecen y nace el del escalón
   * superior. Cuesta una acción, como cualquier jugada del mes.
   */
  mergeAssets(picks, target) {
    const c = this.canMerge(picks, target);
    if (!c.ok) return { ok: false, reason: c.reason };
    this.spendAction();
    this.cash -= c.extra;

    const ids = new Set(picks.map(a => a.instanceId));
    const freedCells = picks.map(a => a.cell).filter(Boolean);
    this.ownedAssets = this.ownedAssets.filter(a => !ids.has(a.instanceId));

    const instance = {
      ...target,
      financials: this.pricedFinancials(target),
      financing: c.financing,
      instanceId: `${target.id}#m${++this._seq}`,
      purchasedMonth: this.month,
      purchasePriceMult: this.cyclePriceMult(),
      purchaseInflation: this.expenseInflation,
    };
    delete instance.cell; delete instance.citySprite;
    instance.yieldFactor = this.rollYieldFactor(instance);
    this.ownedAssets.push(instance);

    return { ok: true, instance, extra: c.extra, freedCells, merged: picks.length };
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
        this.mortgageModifier = this.clampRate(this.mortgageModifier * (1 + ev.value));
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
    if (adj.cashDelta < 0) {
      adj.cashDelta = Math.round(adj.cashDelta * this.eraRisk);
      // los seguros absorben su parte del golpe: para esto los pagas
      const cov = this.insuranceCoverage();
      if (cov > 0) {
        adj._covered = Math.round(-adj.cashDelta * cov);
        adj.cashDelta = Math.round(adj.cashDelta * (1 - cov));
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

    // inflación: tu coste de vida sube poco a poco (~3,7%/año, más rápido cada era)
    this.expenseInflation *= this.inflationRate();

    // los tipos vuelven poco a poco a su sitio: ninguna subida es para siempre
    this.applyRateReversion();

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

    // se resuelve el destino de las apuestas: ruinas y despegues
    const outcomes = this.rollOutcomes();

    // se cierran las ventas que ya han cumplido su plazo
    const salesClosed = this.settlePendingSales();

    // las pólizas de salud también cuidan la cabeza
    this.insurancePolicies().forEach(p => {
      if (this.insurance.has(p.id) && p.happiness) this.happiness += p.happiness;
    });
    this._clampWellbeing();

    // el mes que empieza ya tiene su rendimiento sorteado dentro de la horquilla:
    // el dashboard enseña exactamente lo que vas a cobrar, no una media teórica
    this.rollYields();

    const snap = this.recordSnapshot({
      salary, event, adj, newPhase, outcomes, salesClosed,
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
      taxLabel: (this.taxStructure() || {}).label || 'Persona física',
      taxEmoji: (this.taxStructure() || {}).emoji || '👤',
      taxRate: Math.round(this.effectiveTaxRate() * 10) / 10,
      amortization: Math.round(this.monthlyAmortization()),
      taxableBase: Math.round(this.taxableBase()),
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
      insuranceCost: Math.round(this.insuranceMonthlyCost()),
      insuranceCoverage: Math.round(this.insuranceCoverage() * 100),
      pendingSales: this.pendingSales.length,
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
      investigated: [...this.investigated],
      insurance: [...this.insurance],
      pendingSales: this.pendingSales,
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
    // se encierra en la horquilla: las partidas guardadas antes del tope traían
    // modificadores de ×7 que dejaban toda la cartera en pérdidas
    e.mortgageModifier = e.clampRate(data.mortgageModifier ?? 1);
    e.taxVehicle = data.taxVehicle || 'personal';
    e.happiness = data.happiness ?? 70;
    e.energy = data.energy ?? 80;
    e.salaryBoost = data.salaryBoost ?? 1;
    e.vehicle = data.vehicle ?? null;
    e.expenseInflation = data.expenseInflation ?? 1;
    // partidas anteriores a la indexación: sus activos se sellan con la
    // inflación de HOY, para que la renta no pegue un salto al cargar
    e.ownedAssets.forEach(a => {
      if (a.purchaseInflation == null) a.purchaseInflation = e.expenseInflation;
    });
    e.lifeExpenses = data.lifeExpenses ?? 0;
    e.era = data.era ?? 1;
    e.eraRisk = data.eraRisk ?? 1;
    e.creditBoost = data.creditBoost ?? 1;
    e.eraStartMonth = data.eraStartMonth ?? 1;
    e.actionsUsed = data.actionsUsed ?? 0;
    e.cycleIndex = data.cycleIndex ?? 3;
    e.cycleLeft = data.cycleLeft ?? 4;
    e.investigated = new Set(data.investigated || []);
    e.insurance = new Set(data.insurance || []);
    e.pendingSales = data.pendingSales || [];
    e.firedOnce = new Set(data.firedOnce || []);
    e.lifestyleUsed = new Set(data.lifestyleUsed || []);
    e.history = data.history || [];
    e._seq = data._seq || 0;
    return e;
  }
}
