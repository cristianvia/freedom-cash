/**
 * Leaderboard.js — Liga / clasificación asíncrona.
 * Cada partida puntúa y entra en una clasificación persistente. Es la base
 * (opcional, "nunca acaba") del competitivo. Hoy usa localStorage y rivales
 * "fantasma"; mañana este mismo interfaz (submitScore/topScores) puede
 * apuntar a un backend real para multijugador en vivo.
 */

const LB_KEY = 'freedomcash.leaderboard.v1';

// Rivales "fantasma" para que la liga esté poblada desde la primera partida.
const GHOSTS = [
  { name: 'Ana', emoji: '🦊', profile: 'investor', score: 1465, months: 29 },
  { name: 'Marcos', emoji: '🐺', profile: 'corporate', score: 1390, months: 34 },
  { name: 'Lucía', emoji: '🦉', profile: 'freelance', score: 1275, months: 28 },
  { name: 'Diego', emoji: '🐢', profile: 'corporate', score: 1180, months: 39 },
  { name: 'Sara', emoji: '🐝', profile: 'freelance', score: 1090, months: 31 },
  { name: 'Javi', emoji: '🦅', profile: 'investor', score: 980, months: 36 },
  { name: 'Nora', emoji: '🐬', profile: 'freelance', score: 870, months: 33 },
  { name: 'Pablo', emoji: '🦁', profile: 'corporate', score: 760, months: 44 },
  { name: 'Elena', emoji: '🦄', profile: 'investor', score: 650, months: 41 },
  { name: 'Hugo', emoji: '🐙', profile: 'freelance', score: 540, months: 47 },
  { name: 'Marta', emoji: '🦩', profile: 'investor', score: 430, months: 52 },
  { name: 'Iván', emoji: '🐸', profile: 'corporate', score: 320, months: 58 },
];

function load() {
  try {
    const raw = localStorage.getItem(LB_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* almacenamiento no disponible */ }
  const seed = GHOSTS.map(g => ({ ...g, ghost: true }));
  save(seed);
  return seed;
}
function save(list) {
  try { localStorage.setItem(LB_KEY, JSON.stringify(list)); } catch (e) { /* noop */ }
}

/**
 * Calcula la puntuación de una partida.
 * @param {{won,months,netWorth,ie,happiness,energy,rank,profileId}} r
 */
export function computeScore(r) {
  const profMult = r.profileId === 'corporate' ? 1.15 : 1.0; // el perfil difícil premia más
  const modeMult = r.scoreMult || 1;                          // la dificultad premia más
  let s;
  if (r.won) {
    const speed = Math.max(0, 70 - r.months) * 18;          // más rápido, más puntos
    const worth = Math.round(r.netWorth / 1200);            // patrimonio acumulado
    const wellbeing = Math.round(((r.happiness || 0) + (r.energy || 0)) / 3); // vida equilibrada
    s = 1000 + speed + worth + wellbeing;
    if (r.rank === 1) s += 200;                             // además ganaste la carrera
  } else {
    s = Math.round((r.ie || 0) * 4) + Math.round((r.netWorth || 0) / 2500); // progreso alcanzado
  }
  return Math.max(0, Math.round(s * profMult * modeMult));
}

/** Envía una entrada y devuelve su puesto en la clasificación. */
export function submitScore(entry) {
  const list = load();
  const e = { ...entry, me: true, date: Date.now() };
  list.push(e);
  list.sort((a, b) => b.score - a.score);
  const rank = list.indexOf(e) + 1;
  save(list.slice(0, 60));
  return { rank, total: list.length };
}

/** Devuelve el top-N de la clasificación (ordenado). */
export function topScores(n = 20) {
  return load().sort((a, b) => b.score - a.score).slice(0, n);
}

/** Borra la clasificación (para pruebas). */
export function resetLeaderboard() { save(GHOSTS.map(g => ({ ...g, ghost: true }))); }
