/**
 * tools/sim.mjs — Banco de pruebas de balance.
 * Juega N partidas por perfil usando la IA como "jugador de referencia" y
 * reporta cuántas se ganan y en cuántos meses. Es la red de seguridad para
 * tocar la economía sin romper el ritmo del juego.
 *
 *   node tools/sim.mjs            # 60 partidas por perfil, modo fácil
 *   node tools/sim.mjs 200 hard   # 200 partidas, otro modo de dificultad
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { EconomyEngine } from '../src/engine/EconomyEngine.js';
import { takeBotTurn } from '../src/engine/BotAI.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = (f) => JSON.parse(readFileSync(join(ROOT, 'src/data', f), 'utf8'));

const A = data('assets_database.json').assets;
const P = data('profiles.json').profiles;
const E = data('events.json').events;
const L = data('lifestyle.json').actions;
const V = data('vehicles.json').vehicles;
const G = data('gigs.json').gigs;
const MODES = data('difficulty.json').modes;
const TAX = data('tax.json');
const INS = data('insurance.json');

const RUNS = parseInt(process.argv[2], 10) || 60;
const MODE = MODES.find(m => m.id === process.argv[3]) || MODES[0];
const MAX_MONTHS = 200;

const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : '—';

console.log(`Modo: ${MODE.label} · ${RUNS} partidas por perfil\n`);
for (const profile of P) {
  const months = [];
  const losses = {};
  let wins = 0;
  for (let n = 0; n < RUNS; n++) {
    const e = new EconomyEngine(profile, E, MODE);
    e.setTaxData(TAX);
    e.setInsuranceData(INS);
    let m = 0;
    while (m < MAX_MONTHS && !e.hasWon() && !e.hasLost()) {
      takeBotTurn(e, A, L, V, 0.7, G);
      e.endTurn();
      m++;
    }
    if (e.hasWon()) { wins++; months.push(m); }
    else if (e.hasLost()) losses[e.lossReason()] = (losses[e.lossReason()] || 0) + 1;
    else losses.timeout = (losses.timeout || 0) + 1;
  }
  months.sort((a, b) => a - b);
  console.log(
    profile.id.padEnd(10),
    `gana ${String(wins).padStart(3)}/${RUNS}`,
    `| meses p25/mediana/p75: ${String(pct(months, .25)).padStart(3)} ${String(pct(months, .5)).padStart(3)} ${String(pct(months, .75)).padStart(3)}`,
    `| ${Object.keys(losses).length ? JSON.stringify(losses) : 'sin derrotas'}`);
}
