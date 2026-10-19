'use strict';

/**
 * Progreso global de un lote y tiempo restante estimado.
 *
 * Dos piezas, ambas sin relojes ni disco (el tiempo entra como numero), asi se
 * prueban con simulaciones exactas:
 *
 *  - summarizeBatch(trabajos, ms, { retired }): la FOTO de un instante. Cuantos
 *    van, que fraccion del trabajo (en bytes) esta hecha y una estimacion simple
 *    del tiempo (promedio desde el inicio). Sirve de base y de respaldo.
 *
 *  - BatchTracker: la memoria entre foto y foto. Es lo que arregla los dos
 *    defectos de la 1.0.9:
 *      1. La barra "avanzaba, retrocedia y volvia a avanzar". Causas reales:
 *         (a) el lote total crece mientras se importa carpeta a carpeta;
 *         (b) los tamanos se leen en segundo plano y cambian el peso de cada
 *             trabajo cuando llegan;
 *         (c) "Limpiar completados" quita trabajos ya hechos del lote en curso;
 *         (d) un lote se daba por terminado entre una carpeta y la siguiente.
 *         Ahora la fraccion nunca baja dentro de un mismo lote, lo ya retirado de
 *         la lista se sigue contando, y el lote no se cierra mientras se importa.
 *      2. El tiempo restante era impreciso: se calculaba con el promedio de TODO
 *         el lote (incluido el arranque) y saltaba con cada foto grande. Ahora se
 *         mide el ritmo RECIENTE (media movil), se mide solo con lo ya TERMINADO
 *         (no con el "medio hecho" supuesto de las fotos en curso) y la estimacion
 *         se suaviza para que la cuenta atras baje de forma regular.
 *
 * Reglas heredadas:
 *  - Cada trabajo pesa lo que ocupa su archivo; si aun no se conoce, el tamano medio.
 *  - Fotos y videos se estiman POR SEPARADO (cada carril va a su ritmo) y el lote
 *    acaba cuando acaba el mas lento.
 *  - Mientras un carril con trabajo pendiente no tenga ritmo medido, el tiempo es
 *    `null` ("calculando"): no se inventa un numero.
 *  - El tiempo que cuenta es el ACTIVO (la pausa no cuenta).
 */

const MIN_ELAPSED_MS = 1500; // antes de esto, cualquier ritmo medido es ruido
const UNKNOWN_PROGRESS_FRACTION = 0.5; // una foto "en proceso": ni empezada ni acabada

// Constantes de tiempo del seguimiento (en milisegundos ACTIVOS).
const RATE_WINDOW_MS = 20000; // el ritmo se mide sobre los ultimos ~20 s de tiempo activo
const MIN_RATE_SPAN_MS = 2000; // y hace falta al menos esto de historial para fiarse de el
const ETA_SMOOTHING_MS = 8000; // la hora de fin estimada se mueve despacio hacia cada nueva estimacion
const MIN_STEP_MS = 250; // separacion minima entre dos puntos del historial

const LANE_NAMES = ['image', 'video', 'audio'];

function laneOf(job) {
  return job.kind === 'video' || job.kind === 'audio' ? job.kind : 'image';
}

function emptyRetired() {
  return { image: { total: 0, done: 0 }, video: { total: 0, done: 0 }, audio: { total: 0, done: 0 }, done: 0, errors: 0 };
}

/**
 * jobs: [{ kind, status, size, progress }]  (size/progress pueden faltar)
 * elapsedMs: tiempo activo del lote hasta ahora
 * retired: trabajos del lote que ya salieron de la lista (ver BatchTracker.retire)
 * Devuelve { total, done, errors, processing, fraction, etaMs, lanes }
 *   lanes[carril] = { total, done }: `done` incluye el "medio hecho" supuesto de una
 *   foto en curso y el % real de un video.
 */
function summarizeBatch(jobs, elapsedMs, { retired } = {}) {
  let knownSum = 0;
  let knownCount = 0;
  for (const job of jobs) {
    if (job.size > 0) {
      knownSum += job.size;
      knownCount += 1;
    }
  }
  const averageSize = knownCount > 0 ? knownSum / knownCount : 1;

  const lanes = {
    image: { total: 0, done: 0 },
    video: { total: 0, done: 0 },
    audio: { total: 0, done: 0 }
  };
  let done = 0;
  let errors = 0;
  let processing = 0;
  let retiredCount = 0;

  if (retired) {
    for (const name of LANE_NAMES) {
      if (!retired[name]) continue; // un resumen guardado antes de existir el carril de audio
      lanes[name].total += retired[name].total;
      lanes[name].done += retired[name].done;
    }
    done += retired.done;
    errors += retired.errors;
    retiredCount = retired.done + retired.errors;
  }

  for (const job of jobs) {
    const weight = job.size > 0 ? job.size : averageSize;
    const lane = lanes[laneOf(job)];
    lane.total += weight;
    if (job.status === 'done') {
      done += 1;
      lane.done += weight;
    } else if (job.status === 'error') {
      errors += 1;
      lane.done += weight;
    } else if (job.status === 'processing') {
      processing += 1;
      lane.done += weight * (typeof job.progress === 'number' ? job.progress : UNKNOWN_PROGRESS_FRACTION);
    }
  }

  const totalWeight = LANE_NAMES.reduce((sum, name) => sum + lanes[name].total, 0);
  const doneWeight = LANE_NAMES.reduce((sum, name) => sum + lanes[name].done, 0);
  const fraction = totalWeight > 0 ? Math.min(1, doneWeight / totalWeight) : 0;
  const total = jobs.length + retiredCount;

  let etaMs = null;
  const everythingFinished = done + errors === total;
  if (everythingFinished) {
    etaMs = 0;
  } else if (elapsedMs >= MIN_ELAPSED_MS) {
    let slowest = 0;
    let measurable = true;
    for (const lane of Object.values(lanes)) {
      const remaining = lane.total - lane.done;
      if (remaining <= 0) continue; // este carril ya termino
      if (lane.done <= 0) {
        measurable = false; // tiene trabajo pendiente y aun no se sabe a que ritmo va
        break;
      }
      slowest = Math.max(slowest, remaining / (lane.done / elapsedMs));
    }
    if (measurable) etaMs = Math.round(slowest);
  }

  return { total, done, errors, processing, fraction, etaMs, lanes };
}

/** Memoria de UN lote entre una actualizacion y la siguiente. */
class BatchTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.retired = emptyRetired();
    this.maxFraction = 0;
    this._history = []; // [{ ms, image, video, audio }]: lo hecho en cada carril en distintos momentos (tiempo activo)
    this._endMs = null; // hora de fin estimada (en tiempo activo), ya suavizada
    this._smoothedAt = null; // tiempo activo de la ultima vez que se suavizo
  }

  /**
   * Los trabajos TERMINADOS que salen de la lista (Limpiar completados) siguen
   * contando para el lote en curso: si no, el total y lo hecho bajarian de golpe y
   * la barra retrocederia.
   */
  retire(finishedJobs, allBatchJobs) {
    let sum = 0;
    let count = 0;
    for (const job of allBatchJobs) {
      if (job.size > 0) {
        sum += job.size;
        count += 1;
      }
    }
    const averageSize = count > 0 ? sum / count : 1;
    for (const job of finishedJobs) {
      if (job.status !== 'done' && job.status !== 'error') continue;
      const weight = job.size > 0 ? job.size : averageSize;
      const lane = this.retired[laneOf(job)];
      lane.total += weight;
      lane.done += weight;
      if (job.status === 'done') this.retired.done += 1;
      else this.retired.errors += 1;
    }
  }

  /**
   * jobs: los trabajos del lote que siguen en la lista.
   * activeMs: tiempo activo del lote (la pausa no cuenta).
   * importing: todavia se estan importando archivos (el total puede seguir creciendo).
   */
  update(jobs, activeMs, { importing = false } = {}) {
    const base = summarizeBatch(jobs, activeMs, { retired: this.retired });
    const finished = !importing && base.done + base.errors === base.total;

    // ----- Barra: nunca baja dentro del lote; nunca llega al 100 % mientras quede algo por hacer -----
    let fraction = finished ? 1 : Math.min(base.fraction, 0.995);
    fraction = Math.max(fraction, this.maxFraction);
    this.maxFraction = fraction;

    // ----- Ritmo reciente por carril -----
    this._advanceRates(base.lanes, activeMs);

    // ----- Tiempo restante -----
    let etaMs = null;
    if (finished) {
      etaMs = 0;
      this._endMs = null;
    } else if (activeMs >= MIN_ELAPSED_MS) {
      const raw = this._rawEta(base.lanes, activeMs);
      if (raw !== null) etaMs = this._smooth(raw, activeMs);
    }

    return {
      total: base.total,
      done: base.done,
      errors: base.errors,
      processing: base.processing,
      fraction,
      etaMs,
      importing,
      finished
    };
  }

  /** Guarda un punto del historial (y descarta lo que ya queda fuera de la ventana). */
  _advanceRates(lanes, activeMs) {
    if (activeMs < MIN_ELAPSED_MS) return;
    const last = this._history[this._history.length - 1];
    if (last && activeMs - last.ms < MIN_STEP_MS) return;
    this._history.push({ ms: activeMs, image: lanes.image.done, video: lanes.video.done, audio: lanes.audio.done });
    // Se conserva un punto por fuera de la ventana como referencia de partida.
    while (this._history.length > 2 && this._history[1].ms <= activeMs - RATE_WINDOW_MS) this._history.shift();
  }

  /**
   * Ritmo de cada carril = lo avanzado en la ventana / lo que dura la ventana. Se mide sobre
   * lo mismo que se descuenta de lo pendiente (terminado + parte supuesta de lo que esta en
   * curso), asi las dos cifras son coherentes. Tiempo hasta acabar = el del carril mas lento.
   * null si algun carril con trabajo todavia no tiene ritmo medido.
   */
  _rawEta(lanes, activeMs) {
    const first = this._history[0];
    const lastPoint = this._history[this._history.length - 1];
    let slowest = 0;
    for (const name of LANE_NAMES) {
      const lane = lanes[name];
      const remaining = lane.total - lane.done;
      if (remaining <= 0) continue;
      if (!first || !lastPoint || lastPoint.ms - first.ms < MIN_RATE_SPAN_MS) return null;
      const rate = (lane.done - first[name]) / (activeMs - first.ms);
      if (!(rate > 0)) return null;
      slowest = Math.max(slowest, remaining / rate);
    }
    return slowest;
  }

  /** La hora de fin se acerca despacio a cada nueva estimacion; la cuenta atras baja con el reloj. */
  _smooth(rawEta, activeMs) {
    const target = activeMs + rawEta;
    if (this._endMs === null) {
      this._endMs = target;
    } else {
      const dt = this._smoothedAt === null ? 0 : Math.max(0, activeMs - this._smoothedAt);
      const alpha = 1 - Math.exp(-dt / ETA_SMOOTHING_MS);
      this._endMs = this._endMs * (1 - alpha) + target * alpha;
    }
    this._smoothedAt = activeMs;
    return Math.max(0, Math.round(this._endMs - activeMs));
  }
}

module.exports = { summarizeBatch, BatchTracker };
