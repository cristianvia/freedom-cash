/**
 * Traffic.js
 * ------------------------------------------------------------------
 * Coches circulando por las avenidas.
 *
 * No es adorno. Una ciudad donde no se mueve nada se lee como una captura
 * de pantalla, y el juego se sentía parado aunque por debajo estuvieran
 * corriendo todos los temporizadores. Cuatro coches dando vueltas cambian
 * por completo la sensación, y cuestan cuatro sprites y un bucle.
 *
 * Los coches circulan solos por la red de avenidas: en cada cruce eligen
 * salida, con preferencia por seguir recto y sin dar media vuelta, que es
 * lo que hace que el movimiento parezca tráfico y no un salvapantallas.
 * ------------------------------------------------------------------
 */

const MODELS = ['car_a', 'car_b', 'car_c'];

/**
 * De dirección en la rejilla a sufijo del sprite.
 *
 * El sufijo viene del ángulo con el que se renderizó el modelo, y NO
 * coincide con el punto cardinal de la rejilla: en la proyección, avanzar
 * en +columna baja hacia la derecha de la pantalla. La correspondencia se
 * saca mirando la hoja de contactos, no razonando sobre los nombres.
 */
const DIR_SPRITE = {
  '1,0': 's',    // +col: baja hacia la derecha
  '0,1': 'e',    // +row: baja hacia la izquierda
  '-1,0': 'n',   // -col: sube hacia la izquierda
  '0,-1': 'w',   // -row: sube hacia la derecha
};

const STEP_MS = 1500;      // lo que tarda un coche en cruzar una casilla
const MAX_CARS = 8;

export class Traffic {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.cars = [];
    this.roads = [];
    this.rebuild();
  }

  /* --------------------------- LA RED ---------------------------- */

  rebuild() {
    this.roads = [];
    for (const [k, v] of this.city.terrain) {
      if (v === 'road') {
        const [col, row] = k.split(',').map(Number);
        this.roads.push({ col, row });
      }
    }
    const want = Math.min(MAX_CARS, Math.floor(this.roads.length / 5));
    while (this.cars.length > want) this.remove(this.cars.length - 1);
    while (this.cars.length < want) this.spawn();
  }

  isRoad(col, row) {
    return this.city.terrain.get(col + ',' + row) === 'road';
  }

  /** Salidas posibles desde una casilla, sin contar por dónde se ha venido. */
  exits(col, row, from) {
    const out = [];
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (from && dc === -from[0] && dr === -from[1]) continue;
      if (this.isRoad(col + dc, row + dr)) out.push([dc, dr]);
    }
    // Sin salida solo queda dar media vuelta: es un fondo de saco.
    if (!out.length && from) return [[-from[0], -from[1]]];
    return out;
  }

  /* --------------------------- COCHES ---------------------------- */

  spawn() {
    if (!this.roads.length) return;
    const at = this.roads[Math.floor(Math.random() * this.roads.length)];
    const dirs = this.exits(at.col, at.row, null);
    if (!dirs.length) return;

    const dir = dirs[Math.floor(Math.random() * dirs.length)];
    const model = MODELS[Math.floor(Math.random() * MODELS.length)];
    const img = this.scene.add.image(0, 0, 'page:city-0');
    img.setVisible(false);

    const car = {
      model, img,
      col: at.col, row: at.row,
      dir,
      t: Math.random(),
      speed: 0.85 + Math.random() * 0.4,
    };
    this.cars.push(car);
    this.face(car);
  }

  remove(i) {
    const c = this.cars.splice(i, 1)[0];
    if (c) c.img.destroy();
  }

  /** Cambia el sprite al que mira en la dirección de marcha. */
  face(car) {
    const suffix = DIR_SPRITE[car.dir[0] + ',' + car.dir[1]];
    const name = car.model + '_dir_' + suffix;
    const s = this.scene.atlas.sprites[name];
    if (!s) return;
    const [, , w, h] = s.frame;
    car.img.setTexture('page:' + s.page, name);
    car.img.setOrigin(s.anchor[0] / w, s.anchor[1] / h);
    car.img.setVisible(true);
  }

  /* --------------------------- EL BUCLE -------------------------- */

  update(delta) {
    if (!this.cars.length) return;
    const TW = this.scene.TW, TH = this.scene.TH;

    for (const car of this.cars) {
      car.t += (delta / STEP_MS) * car.speed;

      while (car.t >= 1) {
        car.t -= 1;
        car.col += car.dir[0];
        car.row += car.dir[1];

        const opts = this.exits(car.col, car.row, car.dir);
        if (!opts.length) { car.t = 1; break; }
        // Seguir recto tres de cada cuatro veces: girando siempre al azar,
        // los coches dan vueltas sobre si mismos y parece un salvapantallas.
        const straight = opts.find(d => d[0] === car.dir[0] && d[1] === car.dir[1]);
        car.dir = (straight && Math.random() < 0.75)
          ? straight
          : opts[Math.floor(Math.random() * opts.length)];
        this.face(car);
      }

      const c = car.col + car.dir[0] * car.t;
      const r = car.row + car.dir[1] * car.t;
      car.img.x = (c - r) * (TW / 2);
      car.img.y = (c + r) * (TH / 2);
      // Justo por encima del asfalto y por debajo de los edificios, para
      // que un coche pase por detras de una torre y no por delante.
      car.img.setDepth(-1800 + (c + r) * 0.5);
    }
  }

  destroy() {
    this.cars.forEach(c => c.img.destroy());
    this.cars = [];
  }
}
