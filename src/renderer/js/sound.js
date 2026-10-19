'use strict';

/**
 * Sonido corto de "listo" cuando termina un lote. Se sintetiza con la Web
 * Audio API (dos tonos ascendentes con una envolvente suave) en vez de
 * usar un archivo de audio: nada que empaquetar ni que se pueda romper al
 * quedar mal referenciado, y del mismo tamaño (cero bytes extra) para
 * cualquier idioma en el que se distribuya la app en el futuro.
 */
(function () {
  let ctx = null;

  function getContext() {
    // Se crea la primera vez que hace falta, no al cargar la pagina: los
    // navegadores (Chromium incluido) no dejan arrancar audio antes de que
    // haya habido alguna interaccion del usuario con la pagina.
    if (!ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      ctx = new AudioContextClass();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function tone(context, { freq, start, duration, peakGain }) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(context.destination);

    const t0 = context.currentTime + start;
    // Subida y bajada suaves (sin escalones bruscos) para que no se oiga un
    // "clic" al empezar o terminar el tono.
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peakGain, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function play() {
    try {
      const context = getContext();
      if (!context) return;
      // Dos notas ascendentes (Do5 -> Mi5), breve, discreto -- pensado para
      // notificar sin sobresaltar.
      tone(context, { freq: 523.25, start: 0, duration: 0.16, peakGain: 0.16 });
      tone(context, { freq: 659.25, start: 0.1, duration: 0.22, peakGain: 0.16 });
    } catch {
      // El sonido es un extra, nunca debe romper el aviso visual si algo falla.
    }
  }

  window.CompletionSound = { play };
})();
