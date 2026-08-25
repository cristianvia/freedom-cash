/**
 * rules.js
 * ------------------------------------------------------------------
 * Las constantes que convierten un simulador por turnos en un city
 * builder de reloj. Todo el ritmo del juego sale de aquí.
 *
 * EL PROBLEMA QUE RESUELVE ESTE FICHERO
 *
 * EconomyEngine tiene todas sus cifras expresadas POR MES: la inflación
 * es 1,003 mensual, la deriva de felicidad son 3 puntos al mes, el ciclo
 * económico dura seis fases de unos pocos meses. Si convertimos el mes en
 * un tic de reloj corto —pongamos treinta minutos— salen 48 meses al día
 * y la inflación se come la partida en dos tardes.
 *
 * La tentación es reescalar todas esas constantes. Es un error: son
 * decenas de números afinados entre sí, y tocarlos rompe el equilibrio
 * que costó medir.
 *
 * LA SALIDA es no tocar ninguno y mover el reloj: **un mes del motor son
 * dos horas reales**. Así la inflación sigue siendo la de siempre (un
 * año de juego por día real, ~3,7% anual), el ciclo económico conserva su
 * duración relativa y el motor no se entera de que ha cambiado nada.
 *
 * El juego minuto a minuto NO cuelga de ese tic. Cuelga de los
 * temporizadores de obra y de los ciclos de cobro, que van de treinta
 * segundos a ocho horas. La macroeconomía es el telón de fondo lento; los
 * timers son el juego.
 * ------------------------------------------------------------------
 */

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** Un mes del motor económico, medido en tiempo real. */
export const PERIOD_MS = 2 * HOUR;

/** Tope de meses que se recuperan de una sentada al volver tras un parón. */
export const MAX_CATCHUP_PERIODS = 180;   // ~15 días reales

/**
 * Escalones. El cobro no se acumula para siempre: cada edificio tiene un
 * almacén de CAP_CYCLES ciclos y cuando se llena, para. Ese tope es todo
 * el diseño de un builder: es lo que te hace volver.
 *
 *   buildMs    cuánto tarda la obra
 *   materials  ladrillos que consume construirlo
 *   cycleMs    cada cuánto llena una tanda de renta
 *   capCycles  cuántas tandas caben antes de desbordar
 *
 * La renta por tanda NO se define aquí: sale de assetNetIncome() del
 * motor, escalada por cycleMs/PERIOD_MS. Así un escalón alto no renta más
 * por hora que uno bajo — renta lo mismo, pero molesta menos. Lo que
 * compras al subir de escalón es comodidad y volumen, no un multiplicador
 * escondido.
 */
export const TIERS = [
  null,
  { buildMs: 30 * SECOND, materials: 2, cycleMs: 5 * MINUTE, capCycles: 3 },
  { buildMs: 5 * MINUTE, materials: 8, cycleMs: 20 * MINUTE, capCycles: 3 },
  { buildMs: 30 * MINUTE, materials: 25, cycleMs: 1 * HOUR, capCycles: 3 },
  { buildMs: 2 * HOUR, materials: 60, cycleMs: 4 * HOUR, capCycles: 3 },
  { buildMs: 8 * HOUR, materials: 150, cycleMs: 8 * HOUR, capCycles: 3 },
];

export function tierRules(tier) {
  return TIERS[Math.max(1, Math.min(TIERS.length - 1, tier | 0))];
}

/**
 * Constructores: obras simultáneas. Es el estrangulador clásico del
 * género y el que hace que el tiempo importe de verdad — sin él, con caja
 * suficiente construirías toda la ciudad de golpe y los temporizadores no
 * pintarían nada.
 */
export const BUILDERS_BASE = 2;
export const BUILDERS_MAX = 5;
export function buildersAt(level) {
  return Math.min(BUILDERS_MAX, BUILDERS_BASE + Math.floor((level - 1) / 3));
}

/**
 * Materiales. El segundo recurso existe para que la caja no sea la única
 * decisión: con un solo recurso el juego se reduce a esperar dinero, y
 * esperar no es jugar. Los materiales se producen en edificios propios y
 * se gastan al construir y al mejorar, así que hay que repartir suelo
 * entre lo que renta y lo que fabrica.
 */
export const MATERIAL_PLANTS = [
  {
    id: 'brickworks',
    name: 'Ladrillera',
    sprite: 'factorybuilding_a',
    cost: 3000,
    buildMs: 2 * MINUTE,
    perCycle: 4,
    cycleMs: 4 * MINUTE,
    capCycles: 4,
    minLevel: 1,
  },
  {
    id: 'steelmill',
    name: 'Acería',
    sprite: 'factorybuilding_c',
    cost: 18000,
    buildMs: 20 * MINUTE,
    perCycle: 14,
    cycleMs: 12 * MINUTE,
    capCycles: 4,
    minLevel: 3,
  },
  {
    id: 'permits',
    name: 'Oficina de Permisos',
    sprite: 'government_a',
    cost: 60000,
    buildMs: 1 * HOUR,
    perCycle: 40,
    cycleMs: 30 * MINUTE,
    capCycles: 4,
    minLevel: 6,
  },
];

/** Almacén de materiales: crece con el nivel, para que subir se note. */
export function materialCap(level) {
  return 50 + (level - 1) * 40;
}

/**
 * Edificios de servicio. Son los tres paneles más densos del juego
 * antiguo —fiscalidad, seguros y deuda— convertidos en sitios a los que
 * vas. Un panel con tramos de IRPF no se lee en un móvil; un ayuntamiento
 * que tocas, sí.
 */
export const CIVIC = [
  { id: 'hall', name: 'Ayuntamiento', sprite: 'government_a', panel: 'tax', icon: '🏛️' },
  { id: 'bank', name: 'Banco', sprite: 'bank', panel: 'debt', icon: '🏦' },
  { id: 'insurer', name: 'Aseguradora', sprite: 'hospital_a', panel: 'insurance', icon: '🛡️' },
];

/** El trabajo también es un edificio: el sueldo deja de ser una fila de tabla. */
export const JOB_BUILDING = {
  id: 'job',
  name: 'Tu trabajo',
  sprite: 'businesscenter',
  cycleMs: 30 * MINUTE,
  capCycles: 4,
};

/** Decoración que se siembra sola en los huecos, para que no haya calvas. */
export const SCENERY = ['tree', 'plant', 'plants', 'flowers', 'rock_a001', 'stone02', 'park_b'];

/** Nivel de ciudad: cuánta experiencia cuesta cada peldaño. */
export function xpForLevel(level) {
  return Math.round(120 * Math.pow(1.45, level - 1));
}
