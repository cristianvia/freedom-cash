/**
 * sw.js — Service worker.
 * ------------------------------------------------------------------
 * Hace que el juego se instale en la pantalla de inicio y arranque sin
 * red. Es lo que faltaba para que un juego pensado para el movil se
 * comporte como una app y no como una pestaña.
 *
 * DOS ESTRATEGIAS, Y LA RAZÓN DE QUE SEAN DOS:
 *
 *   El ATLAS y Phaser son grandes, no cambian casi nunca y son lo que más
 *   tarda en descargarse. Van a caché primero: en la segunda visita el
 *   juego abre al instante.
 *
 *   El CÓDIGO y los datos van a red primero, con la caché de reserva. Un
 *   service worker que sirve código viejo es la forma más rápida de que
 *   un despliegue no llegue nunca al jugador, y eso ya me mordió dos
 *   veces con la caché normal del navegador. Si no hay red, tira de lo
 *   guardado y el juego sigue funcionando.
 *
 * La partida vive en localStorage, no aquí: cerrar sin red no pierde nada.
 * ------------------------------------------------------------------
 */

const VERSION = 'fc-v1';
const SHELL = VERSION + '-shell';
const ASSETS = VERSION + '-assets';

/* Lo mínimo para que el juego abra estando sin red. */
const PRECACHE = [
  'game.html',
  'css/game.css?v=6',
  'manifest.json',
  'vendor/phaser.min.js',
  'assets/atlas/sprites.json',
  'assets/atlas/city-0.webp',
  'assets/favicon.svg',
];

/** ¿Es de lo que casi nunca cambia y mucho pesa? */
function isHeavyAsset(url) {
  return /\/(assets\/atlas|vendor)\//.test(url.pathname)
    || /\.(webp|png|jpg|svg|woff2?)$/.test(url.pathname);
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(ASSETS)
      // addAll falla entero si un solo fichero falla; se piden sueltos para
      // que un recurso movido no impida instalar el service worker
      .then(c => Promise.allSettled(PRECACHE.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => !k.startsWith(VERSION))
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // nada de terceros

  if (isHeavyAsset(url)) {
    // caché primero: el atlas pesa 670 KB y no cambia entre despliegues
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(ASSETS).then(c => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // Código y datos: red primero. Servir código viejo desde el service
  // worker es la forma más rápida de que un arreglo no llegue nunca.
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit
        || caches.match('game.html')))
  );
});
