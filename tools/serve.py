"""
serve.py
======================================================================
Servidor de desarrollo que NO deja cachear nada.

    python tools/serve.py [puerto]

El http.server de la biblioteca estandar responde con ETag y Last-Modified,
y Chrome se queda con la copia vieja de los modulos ES y de la hoja de
estilos. Eso cuesta caro: se edita un fichero, se recarga, no cambia nada,
y uno se pone a buscar un fallo que no existe. Me paso dos veces en una
tarde -una con game.css, otra con rules.js- antes de escribir esto.

En produccion no hace falta: GitHub Pages sirve con un max-age corto y las
paginas llevan su propio ?v=. Esto es solo para desarrollar.
"""

import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_response(self, *args, **kwargs):
        # sin esto, un 304 dejaria al navegador usando su copia vieja
        super().send_response(*args, **kwargs)

    def log_message(self, fmt, *args):
        # una linea por peticion satura la consola; solo interesan los fallos
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


class Server(socketserver.TCPServer):
    allow_reuse_address = True


with Server(("127.0.0.1", PORT), NoCache) as httpd:
    print("Freedom Cash en http://127.0.0.1:%d/game.html  (sin cache)" % PORT)
    httpd.serve_forever()
