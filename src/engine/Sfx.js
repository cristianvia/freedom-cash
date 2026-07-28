/**
 * Sfx.js — Sonido y háptica.
 * ------------------------------------------------------------------
 * Todo se sintetiza con WebAudio: ni un solo fichero de audio que descargar,
 * nada que cachear y nada que pedirle a un CDN. El AudioContext se crea en el
 * primer gesto del usuario (los navegadores bloquean el autoplay), así que
 * hasta que no tocas algo el juego está en silencio absoluto.
 */

const KEY = 'freedomcash.sound.v1';

export class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.5;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        this.enabled = d.enabled !== false;
        this.volume = typeof d.volume === 'number' ? d.volume : 0.5;
      }
    } catch (e) { /* sin almacenamiento: valores por defecto */ }
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify({ enabled: this.enabled, volume: this.volume })); }
    catch (e) { /* noop */ }
  }

  toggle() { this.enabled = !this.enabled; this.save(); if (this.enabled) this.play('click'); return this.enabled; }

  /** Crea el contexto en el primer gesto real del usuario. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { this.ctx = new AC(); } catch (e) { this.ctx = null; }
  }

  /* ------------------------- PRIMITIVAS ---------------------------- */

  /** Una nota con envolvente suave (sin clicks de recorte). */
  _tone(freq, { at = 0, dur = 0.14, type = 'sine', gain = 0.3, slideTo = null } = {}) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + at;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
    const peak = Math.max(0.0001, gain * this.volume);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(env).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Ráfaga de ruido: sirve para golpes secos y para el "cling" de monedas. */
  _noise({ at = 0, dur = 0.18, gain = 0.15, freq = 1200, q = 1 } = {}) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + at;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const env = this.ctx.createGain();
    env.gain.value = gain * this.volume;
    src.connect(filter).connect(env).connect(this.ctx.destination);
    src.start(t0);
  }

  /** Arpegio: la base de casi todo lo que suena "a premio". */
  _arp(freqs, { step = 0.075, dur = 0.16, type = 'triangle', gain = 0.26 } = {}) {
    freqs.forEach((f, i) => this._tone(f, { at: i * step, dur, type, gain }));
  }

  /* --------------------------- CATÁLOGO ---------------------------- */

  /** Vibración corta en móvil, si el dispositivo la soporta. */
  haptic(pattern) {
    if (!this.enabled) return;
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* noop */ }
  }

  /**
   * Sonido de relleno (avisos genéricos): se calla si acaba de sonar algo más
   * específico. Evita que comprar suene a "compra" y a "aviso bueno" a la vez.
   */
  playSoft(name) {
    if (Date.now() - (this._lastAt || 0) < 500) return;
    this.play(name);
  }

  play(name) {
    if (!this.enabled) return;
    this.unlock();
    if (!this.ctx) return;
    this._lastAt = Date.now();
    switch (name) {
      case 'click':
        this._tone(520, { dur: 0.05, type: 'square', gain: 0.1 });
        break;

      case 'buy':                       // compra cerrada: dos notas ascendentes
        this._arp([523.25, 783.99], { step: 0.07, dur: 0.15, gain: 0.24 });
        this._noise({ at: 0.02, dur: 0.1, freq: 2600, gain: 0.06 });
        this.haptic(18);
        break;

      case 'month':                     // cobro del mes: lluvia de monedas
        this._arp([659.25, 830.61, 987.77], { step: 0.055, dur: 0.14, gain: 0.2 });
        this._noise({ at: 0.03, dur: 0.28, freq: 3200, q: 2, gain: 0.05 });
        this.haptic(12);
        break;

      case 'good':                      // evento favorable
        this._arp([587.33, 880], { step: 0.08, dur: 0.18, gain: 0.22 });
        break;

      case 'bad':                       // imprevisto: caída descendente
        this._tone(320, { dur: 0.3, type: 'sawtooth', gain: 0.18, slideTo: 150 });
        this.haptic([24, 40, 24]);
        break;

      case 'ruin':                      // algo se fue a cero
        this._tone(220, { dur: 0.55, type: 'sawtooth', gain: 0.22, slideTo: 55 });
        this._noise({ at: 0.05, dur: 0.4, freq: 420, gain: 0.12 });
        this.haptic([40, 60, 90]);
        break;

      case 'achievement':               // logro: arpegio mayor de cuatro notas
        this._arp([523.25, 659.25, 783.99, 1046.5], { step: 0.085, dur: 0.28, gain: 0.24 });
        this.haptic([15, 40, 15]);
        break;

      case 'win':                       // fanfarria de victoria
        this._arp([523.25, 659.25, 783.99, 1046.5, 1318.5], { step: 0.11, dur: 0.4, gain: 0.26 });
        this._tone(1567.98, { at: 0.55, dur: 0.7, type: 'triangle', gain: 0.22 });
        this.haptic([30, 60, 30, 60, 120]);
        break;

      case 'lose':
        this._arp([392, 329.63, 261.63, 196], { step: 0.16, dur: 0.4, type: 'sine', gain: 0.24 });
        this.haptic([60, 80, 160]);
        break;

      case 'cycle':                     // cambia la fase del ciclo económico
        this._tone(392, { dur: 0.35, type: 'triangle', gain: 0.16, slideTo: 587.33 });
        break;

      case 'alert':                     // te quitaron una oportunidad
        this._tone(880, { dur: 0.1, type: 'square', gain: 0.14 });
        this._tone(660, { at: 0.11, dur: 0.14, type: 'square', gain: 0.14 });
        this.haptic(30);
        break;

      default:
        break;
    }
  }
}
