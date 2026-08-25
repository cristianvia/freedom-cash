/**
 * Shim de Phaser.
 *
 * Phaser 3 solo publica el build ESM sin minificar (7,8 MB), asi que se
 * carga el UMD minificado con una etiqueta <script> en game.html y aqui se
 * reexporta el global. De este modo el resto del codigo sigue usando
 * `import Phaser from '../../vendor/phaser.js'` y el proyecto se mantiene
 * sin npm, sin bundler y desplegable tal cual en GitHub Pages.
 */
if (!window.Phaser) {
  throw new Error('Phaser no esta cargado: falta <script src="vendor/phaser.min.js"> en game.html');
}
export default window.Phaser;
