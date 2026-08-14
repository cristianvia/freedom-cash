/**
 * settings.js — Panel de Ajustes.
 * ------------------------------------------------------------------
 * No sabe nada del juego: recibe una lista de grupos con opciones declaradas
 * como descriptores { type, label, get, set }. Añadir una opción nueva es
 * añadir una línea a esa lista, sin tocar el renderizador de aquí.
 *
 * Tipos soportados:
 *   toggle  — interruptor on/off
 *   range   — deslizador numérico (min, max, step, format)
 *
 * Campos comunes: label, hint (opcional), enabled() (opcional: si devuelve
 * false la fila se ve pero no se puede tocar).
 */

const isOn = (opt) => (opt.enabled ? !!opt.enabled() : true);

function rowHTML(opt, i) {
  const off = isOn(opt) ? '' : ' off';
  const txt = `<div class="set-txt"><b>${opt.label}</b>${opt.hint ? `<small>${opt.hint}</small>` : ''}</div>`;

  if (opt.type === 'toggle') {
    const on = !!opt.get();
    return `<div class="set-row${off}" data-i="${i}">
      ${txt}
      <button class="set-switch${on ? ' on' : ''}" role="switch" aria-checked="${on}"
              aria-label="${opt.label}" ${isOn(opt) ? '' : 'disabled'}><i></i></button>
    </div>`;
  }

  if (opt.type === 'range') {
    const v = opt.get();
    const fmt = opt.format ? opt.format(v) : String(v);
    return `<div class="set-row${off}" data-i="${i}">
      ${txt}
      <div class="set-ctl">
        <input type="range" min="${opt.min}" max="${opt.max}" step="${opt.step || 1}"
               value="${v}" aria-label="${opt.label}" ${isOn(opt) ? '' : 'disabled'} />
        <span class="set-val">${fmt}</span>
      </div>
    </div>`;
  }

  return '';
}

/**
 * Abre el modal de ajustes.
 * @param {{title:string, options:object[]}[]} groups
 */
export function showSettings(groups) {
  const flat = [];
  groups.forEach(g => g.options.forEach(o => flat.push(o)));

  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal set-modal">
      <h2>⚙️ Ajustes</h2>
      <p class="lead">Se guardan en este navegador y se conservan entre partidas.</p>
      <div class="set-body"></div>
      <button class="btn-primary" id="set-close" style="margin-top:18px">Cerrar</button>
    </div>`;

  const body = ov.querySelector('.set-body');

  /* Repinta todas las filas: una opción puede habilitar o deshabilitar a otra
     (el volumen depende de que el sonido esté encendido). */
  const paint = () => {
    body.innerHTML = groups.map(g => `
      <div class="set-group">
        <h3>${g.title}</h3>
        ${g.options.map(o => rowHTML(o, flat.indexOf(o))).join('')}
      </div>`).join('');
    wire();
  };

  const wire = () => {
    body.querySelectorAll('.set-row').forEach(row => {
      const opt = flat[+row.dataset.i];
      if (!opt || !isOn(opt)) return;

      if (opt.type === 'toggle') {
        row.querySelector('.set-switch').onclick = () => { opt.set(!opt.get()); paint(); };
      }

      if (opt.type === 'range') {
        const input = row.querySelector('input');
        const val = row.querySelector('.set-val');
        // 'input' actualiza en vivo; repintar aquí cortaría el arrastre del dedo
        input.oninput = () => {
          const v = Number(input.value);
          opt.set(v);
          val.textContent = opt.format ? opt.format(v) : String(v);
        };
        // al soltar sí conviene la muestra sonora (y refrescar dependencias)
        input.onchange = () => { if (opt.commit) opt.commit(Number(input.value)); };
      }
    });
  };

  paint();

  const close = () => { document.removeEventListener('keydown', onKey); ov.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  ov.querySelector('#set-close').onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };   // clic fuera del modal
  document.addEventListener('keydown', onKey);

  document.body.appendChild(ov);
  return ov;
}
