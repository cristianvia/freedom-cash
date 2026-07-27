# 💸 Freedom Cash — El Juego de la Libertad Financiera

Videojuego educativo de estrategia financiera por turnos, inspirado en la filosofía de
*Padre Rico Padre Pobre* / *Cashflow* pero con **ritmo ágil tipo Monopoly**, una
**interfaz Fintech Dark Mode** y una **ciudad isométrica** que crece físicamente con cada
activo que compras.

> **Objetivo:** alcanzar un **Indicador de Emancipación (IE) ≥ 120%** — que tus ingresos
> pasivos cubran el 120% de tus gastos — con un colchón de **6 meses** de tesorería en caja.

---

## 🎮 Cómo jugar

1. Elige tu **Ficha de Vida** (Empleado, Autónomo o Inversor): cada una arranca con sueldo,
   gastos, liquidez y rating de crédito distintos.
2. En el **Marketplace**, compra activos **al contado** o **apalancado con hipoteca**:
   - **Inmuebles** 🏠 · **Negocios digitales** 💻 · **Activos financieros** 📈
3. Cada activo comprado **aparece construido** en tu ciudad isométrica.
4. Pulsa **"Cobrar y pasar de mes"** para liquidar el flujo de caja, disparar un
   **evento macroeconómico** (subida de tipos, vacancia, boom turístico…) y actualizar tu IE.
5. Gestiona el riesgo: la **deuda verde** (ligada a activos que se auto-pagan) es buena;
   la **deuda roja** (préstamos de consumo) penaliza tu IE y ahoga la caja.

Gana cuando `IE ≥ 120%` **y** `caja ≥ 6 × gastos fijos`.

---

## ▶️ Ejecutar en local

El juego usa **ES Modules** y `fetch`, así que necesita servirse por HTTP (no vale abrir el
`index.html` con doble clic):

```bash
# desde la carpeta del proyecto
python -m http.server 8765
# luego abre http://127.0.0.1:8765/index.html
```

**Atajos de demo/test** (parámetros de URL):
- `?auto=corporate|freelance|investor` → arranca directo con ese perfil.
- `&demo=1` → además compra las oportunidades asequibles y pasa un mes (para pruebas).

---

## 🧮 Matemáticas del juego

```
IE = (Ingresos Pasivos Mensuales / (Gastos Fijos + Cuotas Deuda Roja)) × 100

Cashflow Neto = (Sueldo + Ingresos Pasivos) − (Gastos Fijos + Hipotecas + Deuda Roja)
```

- **Deuda verde** = hipoteca de un activo donde `ingreso bruto > cuota`.
- **Deuda roja** = préstamo de consumo; resta liquidez y penaliza el denominador del IE.
- **Apalancamiento** = pagas solo la entrada, pero las subidas de tipos encarecen tu cuota.

---

## 🏗️ Arquitectura

```
freedom-cash/
├── index.html              # layout de 3 columnas (dashboard · ciudad · marketplace)
├── css/styles.css          # tema Fintech Dark Mode
├── assets/sprites/         # sprites isométricos curados (Kenney, CC0)
└── src/
    ├── main.js             # controlador: une lógica + render + DOM
    ├── engine/
    │   ├── EconomyEngine.js # núcleo contable + fiscalidad, refi y serialización
    │   ├── IsoCity.js       # render isométrico 2D con distritos y animaciones
    │   └── BotAI.js         # IA de oponentes (compra, fiscalidad y refi)
    └── data/
        ├── assets_database.json  # catálogo de activos del Marketplace
        ├── profiles.json         # fichas de vida
        └── events.json           # eventos macro e imprevistos
```

**Datos desacoplados:** todo el catálogo de activos, perfiles y eventos vive en JSON, listo
para ampliarse sin tocar la lógica. La `EconomyEngine` es **UI-agnóstica** (testeable en Node).

**Stack:** HTML/CSS + JavaScript (ES Modules) + Canvas 2D isométrico. Preparado para empaquetar
a móvil (Capacitor) o migrar el render a Phaser/Pixi en el futuro.

---

## 🎨 Créditos de arte

Sprites isométricos por **[Kenney](https://kenney.nl)** — packs *Isometric Tiles City* e
*Isometric Tiles Buildings*, licencia **CC0** (dominio público). Ver
`assets/sprites/LICENSE_kenney_*.txt`.

---

## 🗺️ Roadmap

- [x] **Fase 1 (MVP):** single-player, lógica económica, ciudad isométrica, marketplace, eventos.
- [x] **Bots/IA rival** con ranking en vivo (carrera a la libertad financiera).
- [x] **Ciudad viva:** distritos por categoría, animación de construcción y gráfica de IE.
- [x] **Balance validado por simulación** (~20-40 turnos por partida).
- [x] **Estrategia avanzada:** refinanciación de hipotecas y régimen fiscal (persona física vs. sociedad).
- [x] **Negociación P2P:** compra activos a rivales que necesitan liquidez.
- [x] **Persistencia** (localStorage) y **pantalla de fin** con estadísticas.
- [x] **Tutorial guiado** (walk-through con spotlight) para nuevos jugadores.
- [x] **Bienestar (Felicidad + Energía):** decisiones de estilo de vida, eventos de vida,
      dilemas con elección, burnout y abandono. El equilibrio dinero–vida es ahora el core.
- [x] **Feed de actividad** en vivo de los rivales.
- [x] **Vehículos:** decisión de coche (contado/financiar), coste mensual que sube tu
      listón de libertad y enseña que "un coche es un pasivo". Más variedad de edificios por distrito.
- [x] **Vista global de rivales:** mini-ciudades de todos evolucionando en vivo.
- [x] **Capa educativa y realista:** tips contextuales (micro-lecciones), inflación de gastos
      y hitos de vida (mascota, pareja, bebé, casa propia) que suben tu coste de vida.
- [ ] Fase 2: **multijugador en tiempo real** (próxima sesión).
- [ ] Fase 2: sindicación de compras (comprar activos a medias entre jugadores).
- [ ] Fase 3: multijugador en tiempo real.

## 🎯 Estrategia (mecánicas avanzadas)

- **Apalancamiento:** paga solo la entrada; las subidas de tipos encarecen tu cuota.
- **Refinanciar:** comisión del 3% de la hipoteca → cuota −25% y tipo fijo (inmune a subidas).
- **Régimen fiscal:** de persona física (recargo del 25% sobre renta pasiva > 2.000 €/mes) a
  **sociedad** (coste fijo). Solo compensa a rentas altas — como en la vida real.
- **Mercado P2P:** los rivales venden activos cuando necesitan caja; con liquidez lista, cazas gangas.
