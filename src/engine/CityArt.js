/**
 * CityArt.js
 * ------------------------------------------------------------------
 * Dibujo procedural de la ciudad isométrica. Sustituye a los sprites PNG
 * recoloreados, que daban 24 variantes de la misma caja: aquí cada edificio
 * se construye a partir de una ficha (categoría, escalón, semilla) y sale
 * con su altura, su silueta, sus ventanas y sus trastos en la azotea.
 *
 * Tres razones para dibujarlo en vez de pintarlo:
 *   1. El escalón se VE. Un trastero es una caseta; un operador nacional es
 *      una torre. Con sprites fijos, los 9.000 € y los 300.000 € eran iguales.
 *   2. Nitidez a cualquier densidad de pantalla, sin quedarse en 132 px.
 *   3. Variedad infinita y determinista: el mismo activo se dibuja siempre
 *      igual, pero no hay dos vecinos idénticos.
 *
 * Proyección: rombo de TW×TH anclado por su vértice inferior (x, y), igual
 * que hacían los sprites, para no romper nada de lo que ya existía.
 * ------------------------------------------------------------------
 */

export const TW = 132;
export const TH = 66;
const HW = TW / 2;
const HH = TH / 2;

/* --------------------------- ALEATORIEDAD -------------------------- */
/* Determinista: el mismo activo se dibuja igual toda la partida. */

function hashStr(s) {
  let h = 2166136261 >>> 0;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Generador reproducible a partir de una semilla de texto. */
export function rngFrom(seed) {
  let s = hashStr(seed) || 1;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
const between = (rnd, a, b) => a + rnd() * (b - a);
const chance = (rnd, p) => rnd() < p;

/* ----------------------------- COLOR ------------------------------- */

function hsl(h, s, l, a = 1) {
  return `hsla(${h.toFixed(1)}, ${Math.max(0, Math.min(100, s)).toFixed(1)}%, ${Math.max(0, Math.min(100, l)).toFixed(1)}%, ${a})`;
}

/**
 * Las tres caras de un volumen con el sol siempre en el mismo sitio (arriba a
 * la izquierda). Que la luz no cambie nunca es lo que hace que la ciudad se
 * lea como un sitio y no como un collage.
 */
function faces(h, s, l) {
  return {
    top:   hsl(h, s * 0.92, l + 13),
    left:  hsl(h, s, l),
    right: hsl(h, s * 1.04, l - 11),
    line:  hsl(h, s * 0.8, Math.max(6, l - 24)),
  };
}

/*
 * Paletas por distrito. Se apoyan en los mismos tonos que usan las etiquetas
 * del marketplace (inmueble azul, negocio violeta, financiero verde) pero
 * desaturados a colores de fachada: la ciudad queda coordinada con la interfaz
 * sin parecer un cuenco de caramelos. El acento vivo se reserva para los
 * detalles pequeños —toldos, rótulos, ventanas encendidas—, que es donde el
 * color hace falta para que el ojo distinga los edificios entre sí.
 */
export const PALETTES = {
  real_estate: {
    accent: 205,                  // azul: el mismo de la etiqueta "INMUEBLE"
    bodies: [
      { h: 22,  s: 38, l: 52 },   // ladrillo visto
      { h: 36,  s: 30, l: 66 },   // estuco arena
      { h: 210, s: 12, l: 63 },   // hormigón claro
      { h: 8,   s: 26, l: 48 },   // teja envejecida
      { h: 190, s: 14, l: 56 },   // azulejo pálido
      { h: 46,  s: 20, l: 44 },   // piedra tostada
    ],
  },
  digital_business: {
    accent: 262,                  // violeta: etiqueta "NEGOCIO"
    bodies: [
      { h: 216, s: 20, l: 46 },   // acero
      { h: 196, s: 24, l: 44 },   // vidrio oscuro
      { h: 258, s: 18, l: 52 },   // lavanda (uno, no seis)
      { h: 30,  s: 12, l: 58 },   // nave clara
      { h: 240, s: 14, l: 42 },   // pizarra azulada
      { h: 172, s: 16, l: 44 },   // verdín industrial
    ],
  },
  financial: {
    accent: 155,                  // verde: etiqueta "FINANCIERO"
    bodies: [
      { h: 44,  s: 24, l: 62 },   // piedra dorada: la banca de siempre
      { h: 158, s: 16, l: 42 },   // mármol verde
      { h: 210, s: 10, l: 70 },   // caliza clara
      { h: 186, s: 18, l: 40 },   // granito frío
      { h: 96,  s: 14, l: 48 },   // bronce oxidado
      { h: 20,  s: 10, l: 46 },   // travertino oscuro
    ],
  },
};

/* -------------------------- GEOMETRÍA ISO -------------------------- */

/** Los cuatro vértices del rombo de una celda, anclado en (x, y) = vértice sur. */
function tileDiamond(x, y, inset = 0) {
  const k = 1 - inset;
  const cy = y - HH;
  return {
    n: { x, y: cy - HH * k },
    e: { x: x + HW * k, y: cy },
    s: { x, y: cy + HH * k },
    w: { x: x - HW * k, y: cy },
    cx: x, cy,
  };
}

function polygon(ctx, pts, fill, stroke, lw = 1) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}

/**
 * Prisma isométrico apoyado en el rombo de la celda. Devuelve el rombo
 * superior, para poder apilar cuerpos (retranqueos, áticos, torretas).
 */
function isoPrism(ctx, d, h, col, opts = {}) {
  const up = p => ({ x: p.x, y: p.y - h });
  const N = up(d.n), E = up(d.e), S = up(d.s), W = up(d.w);
  // cara izquierda (suroeste) y derecha (sureste)
  polygon(ctx, [d.w, d.s, S, W], col.left, opts.line ? col.line : null, 1);
  polygon(ctx, [d.s, d.e, E, S], col.right, opts.line ? col.line : null, 1);
  polygon(ctx, [N, E, S, W], col.top, opts.line ? col.line : null, 1);
  return { n: N, e: E, s: S, w: W, cx: d.cx, cy: d.cy - h };
}

/**
 * Rejilla de ventanas sobre una cara. La cara se recorre con dos vectores
 * (el del alero y el vertical), así que las ventanas caen en perspectiva
 * sin tener que aplicar transformaciones al contexto.
 */
function windowsOnFace(ctx, a, b, h, rnd, tone, opts) {
  const cols = opts.cols, rows = opts.rows;
  if (cols < 1 || rows < 1) return;
  const ux = (b.x - a.x) / cols, uy = (b.y - a.y) / cols;   // paso horizontal
  const vy = h / rows;                                       // paso vertical
  const mx = opts.mx ?? 0.24, my = opts.my ?? 0.3;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // el bajo suele ser escaparate o portal: se salta
      if (opts.skipGround && r === rows - 1) continue;
      const lit = chance(rnd, opts.litChance ?? 0.3);
      const x0 = a.x + ux * (c + mx), y0 = a.y + uy * (c + mx) - h + vy * r + vy * my;
      const x1 = a.x + ux * (c + 1 - mx), y1 = a.y + uy * (c + 1 - mx) - h + vy * r + vy * my;
      const hh = vy * (1 - my * 2);
      polygon(ctx, [
        { x: x0, y: y0 }, { x: x1, y: y1 },
        { x: x1, y: y1 + hh }, { x: x0, y: y0 + hh },
      ], lit ? opts.litColor : tone, null);
    }
  }
}

/* --------------------------- EL SUELO ------------------------------ */

const GROUND = {
  grass:  { h: 122, s: 26, l: 33 },   // barrio residencial: verde
  ground: { h: 222, s: 14, l: 27 },   // campus de negocio: pizarra fría
  stone:  { h: 40,  s: 10, l: 30 },   // distrito financiero: piedra
  plaza:  { h: 118, s: 22, l: 30 },   // el parque
  road:   { h: 226, s: 10, l: 17 },   // asfalto: netamente más oscuro
  water:  { h: 198, s: 44, l: 30 },
};

/**
 * El canto de la parcela, dibujado UNA vez para todo el tablero. Antes cada
 * losa pintaba su propio faldón y los de dentro asomaban entre las juntas como
 * cuñas negras. Así el terreno se lee como un solo bloque macizo.
 */
export function drawParcel(ctx, cols, rows, depth = 16) {
  const P = (c, r) => ({ x: (c - r) * HW, y: (c + r) * HH - HH });
  const n = P(0, 0), e = P(cols, 0), s = P(cols, rows), w = P(0, rows);
  const down = p => ({ x: p.x, y: p.y + depth });
  // pared suroeste y sureste
  polygon(ctx, [w, s, down(s), down(w)], hsl(30, 12, 15), null);
  polygon(ctx, [s, e, down(e), down(s)], hsl(30, 12, 10), null);
  // filo superior, para que el borde no quede a hueso
  polygon(ctx, [n, e, s, w], null, 'rgba(0,0,0,.35)', 2);
}

/** Losa del terreno: solo la superficie; el canto lo pone drawParcel(). */
export function drawTile(ctx, x, y, kind, seed, opts = {}) {
  const g = GROUND[kind] || GROUND.ground;
  const rnd = rngFrom(seed);
  const l = g.l + between(rnd, -1.8, 1.8);
  const d = tileDiamond(x, y);
  polygon(ctx, [d.n, d.e, d.s, d.w], hsl(g.h, g.s, l), hsl(g.h, g.s, l - 6), 1);

  if (kind === 'road') drawRoadMarks(ctx, d, opts);
  else if (kind === 'water') drawWaterGlints(ctx, d, rnd);
  else if (kind === 'grass' || kind === 'plaza') drawGrassTufts(ctx, d, rnd, g.h);
}

/** Marca viaria discontinua, con bordillos claros a los lados. */
function drawRoadMarks(ctx, d, opts) {
  ctx.save();
  ctx.strokeStyle = 'rgba(190,205,225,.20)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (opts.axis === 'ns') { ctx.moveTo(d.n.x, d.n.y); ctx.lineTo(d.e.x, d.e.y); ctx.moveTo(d.w.x, d.w.y); ctx.lineTo(d.s.x, d.s.y); }
  else { ctx.moveTo(d.n.x, d.n.y); ctx.lineTo(d.w.x, d.w.y); ctx.moveTo(d.e.x, d.e.y); ctx.lineTo(d.s.x, d.s.y); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,232,150,.34)';
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 11]);
  ctx.beginPath();
  if (opts.axis === 'ns') { ctx.moveTo(d.w.x, d.w.y); ctx.lineTo(d.e.x, d.e.y); }
  else { ctx.moveTo(d.n.x, d.n.y); ctx.lineTo(d.s.x, d.s.y); }
  ctx.stroke();
  ctx.restore();
}

/** Mata de hierba: rompe el plano liso del verde sin cargar el dibujo. */
function drawGrassTufts(ctx, d, rnd, hue) {
  ctx.save();
  ctx.strokeStyle = hsl(hue, 26, 42, .5);
  ctx.lineWidth = 1.4;
  const n = Math.floor(between(rnd, 2, 6));
  for (let i = 0; i < n; i++) {
    const u = between(rnd, .2, .8), v = between(rnd, .2, .8);
    const x = d.w.x + (d.e.x - d.w.x) * u;
    const y = d.n.y + (d.s.y - d.n.y) * v;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + between(rnd, -2, 2), y - between(rnd, 3, 5)); ctx.stroke();
  }
  ctx.restore();
}

function drawWaterGlints(ctx, d, rnd) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.16)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 3; i++) {
    const t = between(rnd, .25, .75), w = between(rnd, 12, 26);
    const px = d.w.x + (d.e.x - d.w.x) * t, py = d.n.y + (d.s.y - d.n.y) * t;
    ctx.beginPath(); ctx.moveTo(px - w / 2, py); ctx.lineTo(px + w / 2, py); ctx.stroke();
  }
  ctx.restore();
}

/* --------------------------- SOMBRAS ------------------------------- */

/**
 * Sombra de contacto. Va recortada al rombo de SU celda: una sombra que se
 * salía de la parcela dibujaba una cuña negra sobre el cielo, que es justo lo
 * que delata que esto está pintado y no construido.
 */
function drawShadow(ctx, d, h, tileX, tileY) {
  const clip = tileDiamond(tileX, tileY, 0);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(clip.n.x, clip.n.y);
  ctx.lineTo(clip.e.x, clip.e.y);
  ctx.lineTo(clip.s.x, clip.s.y);
  ctx.lineTo(clip.w.x, clip.w.y);
  ctx.closePath();
  ctx.clip();
  const off = Math.min(26, 5 + h * 0.22);
  ctx.fillStyle = 'rgba(4,8,14,.30)';
  ctx.beginPath();
  ctx.moveTo(d.w.x - off * 0.55, d.w.y - off * 0.28);
  ctx.lineTo(d.n.x - off * 0.55, d.n.y - off * 0.28);
  ctx.lineTo(d.e.x, d.e.y);
  ctx.lineTo(d.s.x, d.s.y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Moneda dibujada, no emoji. En Windows el canvas resuelve 'system-ui' a una
 * fuente sin glifo para 🪙 y salía una caja negra encima de cada edificio.
 */
export function drawCoin(ctx, x, y, alpha = 1, r = 9) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.92, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#c8931f'; ctx.fill();
  ctx.beginPath(); ctx.ellipse(x, y - r * 0.12, r * 0.86, r * 0.78, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#ffce4d'; ctx.fill();
  ctx.strokeStyle = 'rgba(120,80,10,.7)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y - r * 0.45); ctx.lineTo(x, y + r * 0.4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - r * 0.3, y - r * 0.2); ctx.lineTo(x + r * 0.3, y - r * 0.2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - r * 0.3, y + r * 0.12); ctx.lineTo(x + r * 0.3, y + r * 0.12); ctx.stroke();
  ctx.restore();
}

/* ------------------------- LOS EDIFICIOS --------------------------- */

/**
 * Ficha de dibujo de un edificio a partir del activo.
 * @param {object} asset  instancia del portfolio (o del catálogo)
 * @param {number} tier   escalón en su cadena de mejora (1..4)
 */
export function specFor(asset, tier = 1) {
  const cat = PALETTES[asset.category] ? asset.category : 'real_estate';
  const seed = asset.instanceId || asset.id || asset.title || 'x';
  const rnd = rngFrom(seed);
  const pal = PALETTES[cat];
  const body = pick(rnd, pal.bodies);
  const t = Math.max(1, Math.min(4, tier));

  // el escalón manda en la silueta: caseta -> bloque -> torre
  const floors = Math.round(between(rnd, 1 + (t - 1) * 2.2, 2.4 + (t - 1) * 3.4));
  const styles = t >= 3 ? ['tower', 'setback', 'tower', 'slab']
    : t === 2 ? ['slab', 'setback', 'pitched', 'shed']
    : ['hut', 'pitched', 'shed', 'kiosk', 'slab', 'pitched'];

  return {
    cat, seed, tier: t,
    style: pick(rnd, styles),
    body,
    accentHue: pal.accent,
    floors: Math.max(1, floors),
    inset: t === 1 ? between(rnd, 0.30, 0.42) : t === 2 ? between(rnd, 0.20, 0.30) : between(rnd, 0.12, 0.22),
    rot: chance(rnd, 0.5),
  };
}

const FLOOR_H = 15;   // altura de planta en píxeles isométricos

/** Altura total del edificio, para ordenar y para las monedas. */
export function heightOf(spec) {
  return spec.floors * FLOOR_H + (spec.style === 'pitched' ? 14 : 6);
}

/**
 * Dibuja un edificio completo anclado en el vértice sur de su celda.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x @param {number} y  ancla (igual que los sprites antiguos)
 * @param {object} spec  de specFor()
 * @param {number} scale 0..1 para la animación de construcción
 */
export function drawBuilding(ctx, x, y, spec, scale = 1) {
  const rnd = rngFrom(spec.seed + '|draw');
  const s = Math.max(0.02, scale);
  const d = tileDiamond(x, y, spec.inset);
  const col = faces(spec.body.h, spec.body.s, spec.body.l);
  const litColor = hsl(spec.accentHue, 70, 72, 0.92);
  const glassTone = hsl(spec.body.h, spec.body.s * 0.7, spec.body.l - 20, 0.75);

  const total = heightOf(spec) * s;
  drawShadow(ctx, d, total, x, y);

  ctx.save();
  switch (spec.style) {
    case 'hut':      drawHut(ctx, d, spec, col, rnd, s, glassTone, litColor); break;
    case 'pitched':  drawPitched(ctx, d, spec, col, rnd, s, glassTone, litColor); break;
    case 'shed':     drawShed(ctx, d, spec, col, rnd, s, glassTone, litColor); break;
    case 'kiosk':    drawKiosk(ctx, d, spec, col, rnd, s, glassTone, litColor); break;
    case 'setback':  drawSetback(ctx, d, spec, col, rnd, s, glassTone, litColor); break;
    case 'tower':    drawTower(ctx, d, spec, col, rnd, s, glassTone, litColor); break;
    default:         drawSlab(ctx, d, spec, col, rnd, s, glassTone, litColor); break;
  }
  ctx.restore();
}

/* --- caseta: escalón 1, cosas pequeñas (trastero, plaza de garaje) --- */
function drawHut(ctx, d, spec, col, rnd, s, glass, lit) {
  const h = spec.floors * FLOOR_H * s;
  const top = isoPrism(ctx, d, h, col, { line: true });
  // portón: la mancha oscura que dice "esto es un trastero"
  doorOnFace(ctx, d.w, d.s, h, hsl(spec.body.h, 12, 22), 0.34, 0.62);
  if (chance(rnd, 0.55)) awning(ctx, d.s, d.e, h, hsl(spec.accentHue, 55, 52));
  flatRoof(ctx, top, spec, col, rnd, s);
}

/* --- tejado a dos aguas: casitas y locales --- */
function drawPitched(ctx, d, spec, col, rnd, s, glass, lit) {
  const h = spec.floors * FLOOR_H * s;
  const top = isoPrism(ctx, d, h, col, { line: true });
  windowsOnFace(ctx, d.w, d.s, h, rnd, glass,
    { cols: 2, rows: Math.max(1, spec.floors), litChance: .34, litColor: lit, skipGround: spec.floors > 1 });
  windowsOnFace(ctx, d.s, d.e, h, rnd, glass,
    { cols: 2, rows: Math.max(1, spec.floors), litChance: .28, litColor: lit, skipGround: spec.floors > 1 });
  // cubierta: dos faldones que se juntan en la cumbrera
  const ridgeH = 15 * s;
  const rc = faces(spec.body.h + 6, spec.body.s + 12, spec.body.l - 16);
  const mid1 = { x: (top.n.x + top.w.x) / 2, y: (top.n.y + top.w.y) / 2 - ridgeH };
  const mid2 = { x: (top.e.x + top.s.x) / 2, y: (top.e.y + top.s.y) / 2 - ridgeH };
  polygon(ctx, [top.w, top.n, mid1], rc.top, rc.line, 1);
  polygon(ctx, [top.n, top.e, mid2, mid1], rc.top, rc.line, 1);
  polygon(ctx, [top.w, mid1, mid2, top.s], rc.left, rc.line, 1);
  polygon(ctx, [top.s, mid2, top.e], rc.right, rc.line, 1);
  if (chance(rnd, .5)) chimney(ctx, mid1, mid2, s, spec);
}

/* --- nave: baja, ancha y con cubierta de diente de sierra --- */
function drawShed(ctx, d, spec, col, rnd, s, glass, lit) {
  const h = Math.max(1, spec.floors * 0.7) * FLOOR_H * s;
  const top = isoPrism(ctx, d, h, col, { line: true });
  windowsOnFace(ctx, d.w, d.s, h, rnd, glass, { cols: 4, rows: 1, litChance: .3, litColor: lit, my: .34 });
  doorOnFace(ctx, d.s, d.e, h, hsl(spec.body.h, 12, 20), 0.42, 0.72);
  // dientes de sierra: dos lucernarios inclinados
  const rc = faces(spec.body.h, spec.body.s * .6, spec.body.l - 8);
  for (let i = 0; i < 2; i++) {
    const t = 0.18 + i * 0.42;
    const a = lerpP(top.w, top.n, t), b = lerpP(top.s, top.e, t);
    const a2 = lerpP(top.w, top.n, t + 0.3), b2 = lerpP(top.s, top.e, t + 0.3);
    const up = 9 * s;
    polygon(ctx, [a, b, { x: b2.x, y: b2.y - up }, { x: a2.x, y: a2.y - up }], rc.top, rc.line, 1);
    polygon(ctx, [{ x: a2.x, y: a2.y - up }, { x: b2.x, y: b2.y - up }, b2, a2],
      hsl(spec.accentHue, 44, 62, .55), null);
  }
  roofEdge(ctx, top, spec);
}
const lerpP = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/* --- quiosco: lo más pequeño que puede tener una parcela --- */
function drawKiosk(ctx, d, spec, col, rnd, s, glass, lit) {
  const small = shrinkDiamond({ ...d, cx: d.cx, cy: d.cy }, 0.18);
  const h = 30 * s;   // alto de caseta, no de bordillo: si no, la marquesina lo tapaba
  const top = isoPrism(ctx, small, h, col, { line: true });
  windowsOnFace(ctx, small.w, small.s, h, rnd, glass,
    { cols: 2, rows: 1, litChance: .55, litColor: lit, my: .26 });
  doorOnFace(ctx, small.s, small.e, h, hsl(spec.body.h, 14, 22), 0.42, 0.66);
  awning(ctx, small.w, small.s, h * 0.72, hsl(spec.accentHue, 56, 52));
  // marquesina fina volada sobre el conjunto
  const vis = shrinkDiamond(top, -0.14);
  const lift = 4 * s;
  const up = p => ({ x: p.x, y: p.y - lift });
  polygon(ctx, [up(vis.n), up(vis.e), up(vis.s), up(vis.w)],
    hsl(spec.body.h, spec.body.s * .7, spec.body.l + 20), hsl(spec.accentHue, 50, 55, .8), 1.4);
  polygon(ctx, [up(vis.w), up(vis.s), vis.s, vis.w], hsl(spec.body.h, spec.body.s * .7, spec.body.l + 4), null);
  polygon(ctx, [up(vis.s), up(vis.e), vis.e, vis.s], hsl(spec.body.h, spec.body.s * .7, spec.body.l - 6), null);
}

/* --- bloque recto: el caballo de batalla --- */
function drawSlab(ctx, d, spec, col, rnd, s, glass, lit) {
  const h = spec.floors * FLOOR_H * s;
  const top = isoPrism(ctx, d, h, col, { line: true });
  const rows = Math.max(1, spec.floors);
  windowsOnFace(ctx, d.w, d.s, h, rnd, glass, { cols: 3, rows, litChance: .3, litColor: lit, skipGround: true });
  windowsOnFace(ctx, d.s, d.e, h, rnd, glass, { cols: 3, rows, litChance: .26, litColor: lit, skipGround: true });
  storefront(ctx, d, h, rows, spec, rnd);
  flatRoof(ctx, top, spec, col, rnd, s);
}

/* --- retranqueo: cuerpo bajo ancho + torre estrecha encima --- */
function drawSetback(ctx, d, spec, col, rnd, s, glass, lit) {
  const lowFloors = Math.max(1, Math.round(spec.floors * 0.45));
  const highFloors = Math.max(1, spec.floors - lowFloors);
  const h1 = lowFloors * FLOOR_H * s;
  const t1 = isoPrism(ctx, d, h1, col, { line: true });
  windowsOnFace(ctx, d.w, d.s, h1, rnd, glass, { cols: 3, rows: lowFloors, litChance: .3, litColor: lit, skipGround: true });
  windowsOnFace(ctx, d.s, d.e, h1, rnd, glass, { cols: 3, rows: lowFloors, litChance: .26, litColor: lit, skipGround: true });
  storefront(ctx, d, h1, lowFloors, spec, rnd);

  const d2 = shrinkDiamond(t1, 0.3);
  const c2 = faces(spec.body.h, spec.body.s, spec.body.l + 5);
  const h2 = highFloors * FLOOR_H * s;
  const t2 = isoPrism(ctx, d2, h2, c2, { line: true });
  windowsOnFace(ctx, d2.w, d2.s, h2, rnd, glass, { cols: 2, rows: highFloors, litChance: .38, litColor: lit });
  windowsOnFace(ctx, d2.s, d2.e, h2, rnd, glass, { cols: 2, rows: highFloors, litChance: .32, litColor: lit });
  flatRoof(ctx, t2, spec, c2, rnd, s);
}

/* --- torre: el escalón alto de una cadena, con cinturón de vidrio --- */
function drawTower(ctx, d, spec, col, rnd, s, glass, lit) {
  const h = spec.floors * FLOOR_H * s;
  const top = isoPrism(ctx, d, h, col, { line: true });
  const rows = Math.max(3, spec.floors);
  windowsOnFace(ctx, d.w, d.s, h, rnd, glass, { cols: 3, rows, litChance: .42, litColor: lit, mx: .16, my: .22, skipGround: true });
  windowsOnFace(ctx, d.s, d.e, h, rnd, glass, { cols: 3, rows, litChance: .36, litColor: lit, mx: .16, my: .22, skipGround: true });
  storefront(ctx, d, h, rows, spec, rnd);

  // coronación: casetón de máquinas y antena, que es lo que da escala
  const d2 = shrinkDiamond(top, 0.45);
  const c2 = faces(spec.body.h, spec.body.s * .8, spec.body.l - 6);
  const t2 = isoPrism(ctx, d2, 12 * s, c2, { line: true });
  antenna(ctx, t2, spec, s, 26);
  roofEdge(ctx, top, spec);
}

/* ----------------------- PIEZAS PEQUEÑAS --------------------------- */

function shrinkDiamond(t, k) {
  const cx = t.cx, cy = t.cy;
  const f = p => ({ x: cx + (p.x - cx) * (1 - k), y: cy + (p.y - cy) * (1 - k) });
  return { n: f(t.n), e: f(t.e), s: f(t.s), w: f(t.w), cx, cy };
}

/** Peto de cubierta + algún trasto: lo que hace que una azotea parezca real. */
function flatRoof(ctx, top, spec, col, rnd, s) {
  roofEdge(ctx, top, spec);
  const props = Math.floor(between(rnd, 0, 2.6));
  for (let i = 0; i < props; i++) {
    const d2 = shrinkDiamond(top, between(rnd, 0.55, 0.75));
    const off = between(rnd, -12, 12);
    const dd = { n: sh(d2.n, off), e: sh(d2.e, off), s: sh(d2.s, off), w: sh(d2.w, off), cx: d2.cx + off, cy: d2.cy };
    const pc = faces(spec.body.h, spec.body.s * .5, spec.body.l - 14);
    isoPrism(ctx, dd, between(rnd, 5, 11) * s, pc, { line: false });
  }
  if (chance(rnd, .35)) antenna(ctx, top, spec, s, between(rnd, 12, 22));
}
const sh = (p, dx) => ({ x: p.x + dx, y: p.y });

/**
 * Filo del peto en el color de la categoría. Es una línea de dos píxeles, pero
 * es lo que permite saber de un vistazo si una torre es un negocio o un fondo
 * sin tener que mirar en qué cuadrante está.
 */
function roofEdge(ctx, top, spec) {
  polygon(ctx, [top.n, top.e, top.s, top.w], null, hsl(spec.accentHue, 58, 62, .85), 1.8);
}

function antenna(ctx, top, spec, s, len) {
  ctx.save();
  ctx.strokeStyle = hsl(spec.body.h, 10, 78, .85);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(top.cx, top.cy);
  ctx.lineTo(top.cx, top.cy - len * s);
  ctx.stroke();
  ctx.fillStyle = hsl(spec.accentHue, 80, 62, .95);
  ctx.beginPath();
  ctx.arc(top.cx, top.cy - len * s, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function chimney(ctx, m1, m2, s, spec) {
  const x = (m1.x + m2.x) / 2 + 10, y = (m1.y + m2.y) / 2 + 2;
  const c = faces(spec.body.h + 10, spec.body.s, spec.body.l - 20);
  const d = { n: { x, y: y - 5 }, e: { x: x + 5, y }, s: { x, y: y + 5 }, w: { x: x - 5, y }, cx: x, cy: y };
  isoPrism(ctx, d, 13 * s, c, { line: false });
}

/** Puerta o portón sobre la cara suroeste. */
function doorOnFace(ctx, a, b, h, color, wFrac, hFrac) {
  const mx = (1 - wFrac) / 2;
  const x0 = a.x + (b.x - a.x) * mx, y0 = a.y + (b.y - a.y) * mx;
  const x1 = a.x + (b.x - a.x) * (1 - mx), y1 = a.y + (b.y - a.y) * (1 - mx);
  const dh = h * hFrac;
  polygon(ctx, [
    { x: x0, y: y0 - dh }, { x: x1, y: y1 - dh }, { x: x1, y: y1 }, { x: x0, y: y0 },
  ], color, null);
}

/** Bajo comercial: franja de escaparate con su toldo de color. */
function storefront(ctx, d, h, rows, spec, rnd) {
  const bandH = Math.min(h * 0.34, h / rows);
  const glassC = hsl(spec.body.h, 14, 24, .92);
  polygon(ctx, [
    { x: d.w.x, y: d.w.y - bandH }, { x: d.s.x, y: d.s.y - bandH }, d.s, d.w,
  ], glassC, null);
  polygon(ctx, [
    { x: d.s.x, y: d.s.y - bandH }, { x: d.e.x, y: d.e.y - bandH }, d.e, d.s,
  ], hsl(spec.body.h, 14, 19, .92), null);
  if (chance(rnd, .6)) awning(ctx, d.w, d.s, bandH, hsl(spec.accentHue, 52, 48));
  // rótulo encendido
  if (chance(rnd, .45)) {
    ctx.save();
    ctx.fillStyle = hsl(spec.accentHue, 78, 62, .9);
    const cx = (d.w.x + d.s.x) / 2, cy = (d.w.y + d.s.y) / 2 - bandH - 3;
    ctx.fillRect(cx - 9, cy - 3, 18, 3);
    ctx.restore();
  }
}

/** Toldo: un plano inclinado que sobresale de la fachada. */
function awning(ctx, a, b, h, color) {
  const out = 7;
  polygon(ctx, [
    { x: a.x, y: a.y - h }, { x: b.x, y: b.y - h },
    { x: b.x - out * 0.4, y: b.y - h + out * 0.7 }, { x: a.x - out * 0.4, y: a.y - h + out * 0.7 },
  ], color, null);
}

/* ------------------------- VEGETACIÓN ------------------------------ */

export function drawTree(ctx, x, y, seed) {
  const rnd = rngFrom(seed + '|tree');
  const d = tileDiamond(x, y);
  const cx = d.cx + between(rnd, -14, 14), cy = d.cy + between(rnd, -6, 6);
  const hTrunk = between(rnd, 9, 14);
  const r = between(rnd, 11, 16);
  ctx.save();
  ctx.fillStyle = 'rgba(4,8,14,.22)';
  ctx.beginPath(); ctx.ellipse(cx + 3, cy + 2, r * 0.9, r * 0.42, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = hsl(28, 26, 30);
  ctx.fillRect(cx - 1.6, cy - hTrunk, 3.2, hTrunk);
  const hue = between(rnd, 108, 142);
  ctx.fillStyle = hsl(hue, 30, 34);
  ctx.beginPath(); ctx.ellipse(cx, cy - hTrunk - r * 0.55, r, r * 0.85, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = hsl(hue, 34, 44);
  ctx.beginPath(); ctx.ellipse(cx - r * 0.22, cy - hTrunk - r * 0.75, r * 0.62, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/** Farola: puntúa las calles y da escala al conjunto. */
export function drawLamp(ctx, x, y, seed) {
  const rnd = rngFrom(seed + '|lamp');
  const d = tileDiamond(x, y);
  const cx = d.cx + between(rnd, -20, 20), cy = d.cy + between(rnd, -4, 8);
  ctx.save();
  ctx.strokeStyle = 'rgba(200,215,235,.55)';
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 20); ctx.stroke();
  ctx.fillStyle = 'rgba(255,214,140,.9)';
  ctx.beginPath(); ctx.arc(cx, cy - 21.5, 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,214,140,.10)';
  ctx.beginPath(); ctx.ellipse(cx, cy, 15, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/* ------------------------- MINIATURAS ------------------------------ */
/*
 * Las tarjetas del marketplace se pintan con el MISMO dibujo que la ciudad.
 * Si la ficha enseñara un sprite y la parcela otra cosa, el jugador no
 * reconocería lo que acaba de comprar.
 */
const thumbCache = new Map();

export function buildingThumb(asset, tier = 1, size = 96) {
  const key = `${asset.id}|${tier}|${size}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const cv = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = size * dpr; cv.height = size * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const spec = specFor({ ...asset, instanceId: asset.id }, tier);
  // se ajusta a la caja real del edificio: si no, una caseta salía como una
  // mota perdida en la esquina y una torre se salía del marco
  const bw = TW * (1 - spec.inset) + 12;
  const bh = TH * (1 - spec.inset) + heightOf(spec) + 14;
  const k = Math.min(size / bw, size / bh) * 0.94;
  ctx.save();
  ctx.translate(size / 2, size / 2 + (TH * (1 - spec.inset) / 2 + heightOf(spec) / 2) * k);
  ctx.scale(k, k);
  drawBuilding(ctx, 0, 0, spec, 1);
  ctx.restore();

  const url = cv.toDataURL('image/png');
  thumbCache.set(key, url);
  return url;
}
