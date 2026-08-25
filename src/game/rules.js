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
 * Cada cuánto pasa algo en tu ciudad.
 *
 * Va SUELTO del mes a propósito. Atado al mes, ocurría un suceso cada dos
 * horas y la ciudad parecía muerta; y acortar el mes para que pasaran más
 * cosas habría disparado la inflación, que es justo lo que el reloj de dos
 * horas evita. Son dos relojes distintos porque miden dos cosas distintas:
 * uno la macroeconomía, que es lenta, y otro lo que te pasa, que no.
 */
export const INCIDENT_MS = 22 * MINUTE;

/** Sucesos que se recuperan al volver. Más allá, se descartan los viejos. */
export const MAX_CATCHUP_INCIDENTS = 12;

/**
 * Suelo del bienestar mientras estás fuera.
 *
 * Estando delante puedes descansar, salir a cenar o ir al gimnasio. Con el
 * juego cerrado no puedes hacer nada, así que dejar que el desgaste siga
 * bajando sería castigarte por cerrar la pestaña. El desgaste de los meses
 * recuperados frena aquí; los sucesos y tus propias decisiones sí pueden
 * bajarte de este suelo, porque esos los eliges tú.
 */
export const OFFLINE_WELLBEING_FLOOR = 35;

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
/*
 * Los tiempos del arranque son cortos a propósito. Con la primera obra en
 * dos minutos y el primer cobro a los cinco, el jugador se pasaba los diez
 * primeros minutos mirando: no llegaba a aprender el bucle porque no le
 * daba tiempo a repetirlo. Los escalones altos siguen siendo largos, que
 * es donde el género quiere que esperes.
 *
 * Acortar un ciclo NO regala dinero: la renta por tanda sale de la cifra
 * mensual escalada por cycleMs/PERIOD_MS, así que lo que cambia es cada
 * cuánto cobras, no cuánto ganas por hora.
 */
export const TIERS = [
  null,
  { buildMs: 20 * SECOND, materials: 2, cycleMs: 3 * MINUTE, capCycles: 3 },
  { buildMs: 3 * MINUTE, materials: 8, cycleMs: 10 * MINUTE, capCycles: 3 },
  { buildMs: 15 * MINUTE, materials: 25, cycleMs: 30 * MINUTE, capCycles: 3 },
  { buildMs: 1 * HOUR, materials: 60, cycleMs: 2 * HOUR, capCycles: 3 },
  { buildMs: 4 * HOUR, materials: 150, cycleMs: 6 * HOUR, capCycles: 3 },
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
    // 1x1 a proposito. Con un modelo de 2x2 la ladrillera no cabia en la
    // manzana de partida —tres filas de fondo, y los edificios de servicio
    // ocupando la del medio— y el primer encargo del tutorial era
    // imposible de cumplir.
    sprite: 'factorystructure_a',
    cost: 3000,
    buildMs: 45 * SECOND,
    perCycle: 3,
    cycleMs: 90 * SECOND,
    capCycles: 4,
    minLevel: 1,
  },
  {
    id: 'steelmill',
    name: 'Acería',
    sprite: 'factoryenterence',
    cost: 18000,
    buildMs: 10 * MINUTE,
    perCycle: 14,
    cycleMs: 8 * MINUTE,
    capCycles: 4,
    minLevel: 3,
  },
  {
    id: 'permits',
    name: 'Oficina de Permisos',
    sprite: 'postoffice',
    cost: 60000,
    buildMs: 30 * MINUTE,
    perCycle: 40,
    cycleMs: 20 * MINUTE,
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
  // La aseguradora era hospital_a, de 3x2: no cabia en la manzana inicial y
  // se quedaba SIN COLOCAR, con lo que los seguros eran inalcanzables.
  { id: 'insurer', name: 'Aseguradora', sprite: 'policestation', panel: 'insurance', icon: '🛡️' },
];

/** El trabajo también es un edificio: el sueldo deja de ser una fila de tabla. */
export const JOB_BUILDING = {
  id: 'job',
  name: 'Tu trabajo',
  sprite: 'businesscenter',
  cycleMs: 12 * MINUTE,
  capCycles: 4,
};

/** Decoración que se siembra sola en los huecos, para que no haya calvas. */
export const SCENERY = ['tree', 'plant', 'plants', 'flowers', 'rock_a001', 'stone02', 'park_b'];

/** Nivel de ciudad: cuánta experiencia cuesta cada peldaño. */
export function xpForLevel(level) {
  return Math.round(120 * Math.pow(1.45, level - 1));
}
