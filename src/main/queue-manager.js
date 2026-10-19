'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');
const { processMedia } = require('./processor');
const { mediaKind } = require('./processor/formats');
const { loadSettings } = require('./settings-store');
const { getDefaultConcurrency } = require('./system-info');
const manifestStore = require('./manifest-store');
const { BatchTracker } = require('./batch-progress');

/**
 * Procesa varias imagenes a la vez, con un limite (ver system-info.js). Esto
 * es seguro porque cada trabajo es completamente independiente: su propio
 * archivo de entrada, su propio archivo de salida, sin memoria ni estado
 * compartido entre trabajos. No hay condicion de carrera posible. Lo que se
 * evita a proposito es paralelismo *sin limite* (que si podria saturar
 * memoria/disco con lotes enormes), no la concurrencia en si.
 *
 * Los VIDEOS van por un carril aparte con un unico worker: ffmpeg ya reparte
 * cada video entre todos los nucleos, asi que codificar dos a la vez solo los
 * haria pelearse entre si (y gastaria el doble de memoria) sin acabar antes.
 * Como es un carril propio, un video largo no frena a las fotos que esten en
 * la misma cola, ni al reves. Los AUDIOS tienen el suyo, con hasta MAX_AUDIO_WORKERS a la vez.
 */
const LANES = ['image', 'video', 'audio'];
// Los audios los codifica ffmpeg con un solo hilo y gastan muy poca memoria: varios a la vez
// aprovechan los nucleos (de hecho, un audio nunca espera a un video largo ni a las fotos).
const MAX_AUDIO_WORKERS = 4;
const jobKind = (job) => job.kind || 'image';

// Con que frecuencia (como minimo) se propaga el avance de un video a la
// ventana. La ventana ya limita sus envios; esto evita ademas trabajo inutil
// en la cola cuando ffmpeg informa decenas de veces por segundo.
const PROGRESS_STEP = 0.01;

class QueueManager extends EventEmitter {
  constructor() {
    super();
    this.jobs = [];
    // Los trabajos solo se anaden al final y avanzan siempre en orden
    // (pending -> processing -> done|error), asi que todo lo anterior a este
    // indice YA no esta pendiente. Buscar el siguiente pendiente parte de
    // aqui en vez de recorrer la lista entera: con miles de fotos, eso era
    // O(n) por cada foto (O(n^2) en el lote) y ahora es O(1) amortizado.
    // Hay un cursor por carril (imagenes / videos): cada uno se salta lo que
    // no es suyo, y lo anterior a el nunca vuelve a ser reclamable por ese carril.
    this._cursors = { image: 0, video: 0, audio: 0 };
    this.isProcessing = false;
    this.paused = false;
    this.concurrency = getDefaultConcurrency();
    this.activeWorkers = 0; // workers de imagenes
    this.activeVideoWorkers = 0;
    this.activeAudioWorkers = 0;
    // Progreso global (ver batch-progress.js). Cada trabajo lleva el numero del
    // lote al que pertenece; el lote nuevo empieza cuando entra trabajo y el
    // anterior ya habia terminado. El tiempo que se mide es solo el ACTIVO: ni
    // la pausa ni los ratos sin hacer nada cuentan para el ritmo.
    this._batchId = 0;
    // Memoria del lote entre un aviso y el siguiente: la barra no retrocede y el tiempo
    // restante usa el ritmo reciente (ver batch-progress.js).
    this._tracker = new BatchTracker();
    // Cuantas importaciones estan en curso. Mientras haya alguna, el lote sigue
    // ABIERTO aunque la cola se vacie entre una carpeta y la siguiente: antes eso
    // cerraba el lote y el siguiente empezaba de cero (la barra volvia a 0).
    this._importing = 0;
    this._orderVersion = 0; // sube cada vez que se reordena a mano (la pantalla recoloca las filas)
    this._activeMs = 0;
    this._activeSince = null;
    // Resumen del lote en curso: se acumula entre pausas y reanudaciones y se
    // entrega (y se pone a cero) solo cuando la cola de verdad se vacia.
    this.batch = { done: 0, errors: 0, savedBytes: 0 };
  }

  /** Empieza un lote nuevo: contador de tiempo y memoria del progreso a cero. */
  _startNewBatch() {
    this._batchId += 1;
    this._activeMs = 0;
    this._tracker.reset();
  }

  /**
   * Avisa de que empieza una importacion (copiar carpetas, abrir un comprimido...).
   * Hasta `endImport()` el lote no se da por terminado y su total puede seguir creciendo.
   * Es un contador porque pueden solaparse varias.
   */
  beginImport() {
    if (this._importing === 0 && !this.isProcessing && !this._hasPending()) this._startNewBatch();
    this._importing += 1;
    this._emitUpdate();
  }

  /** Cierra lo abierto por beginImport(). Si ya no queda nada por hacer, el lote termina ahora. */
  endImport() {
    if (this._importing === 0) return;
    this._importing -= 1;
    if (this._importing === 0 && !this.isProcessing && !this.paused && !this._hasPending()) this._finishBatch();
    this._emitUpdate();
  }

  addJobs(fileToOutputPairs) {
    // Si lo anterior ya habia terminado del todo, esto es un lote nuevo.
    if (this._importing === 0 && !this.isProcessing && !this._hasPending()) this._startNewBatch();
    const newJobs = fileToOutputPairs.map(({ inputPath, outputPath }) => ({
      id: crypto.randomUUID(),
      name: path.basename(inputPath),
      kind: mediaKind(inputPath) || 'image',
      progress: null, // 0..1, videos y audios mientras se codifican
      batchId: this._batchId,
      size: null, // bytes; se lee en segundo plano (para el progreso global)
      inputPath,
      outputPath,
      status: 'pending', // pending -> processing -> done | error
      report: null,
      error: null
    }));
    // Bucle en vez de push(...lista): con lotes de ~100k fotos el spread
    // supera el limite de argumentos de JS y lanza RangeError.
    for (const job of newJobs) this.jobs.push(job);
    this._emitUpdate();
    this._ensureWorkers();
    this._readSizes(newJobs);
    return newJobs.map((j) => j.id);
  }

  /**
   * Lee el tamano de los archivos en segundo plano, de 16 en 16 (no bloquea ni
   * satura el disco con un lote enorme). Solo sirve para pesar el progreso
   * global: si falla alguno, ese trabajo simplemente no tiene tamano.
   */
  async _readSizes(jobs) {
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next];
        next += 1;
        try {
          job.size = (await fs.stat(job.inputPath)).size;
        } catch {
          job.size = null;
        }
        if (next % 200 === 0) this._emitUpdate();
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, jobs.length) }, worker));
    this._emitUpdate();
  }

  /**
   * Levanta los workers que falten (hasta `concurrency`, y nunca mas que
   * trabajos pendientes). Se llama al agregar trabajos y al reanudar. Antes
   * solo se lanzaba un grupo de workers "de golpe" cuando la cola estaba
   * parada: si se agregaban fotos (o se pulsaba Reanudar) mientras aun
   * quedaba un worker terminando, los demas ya se habian ido y el resto del
   * lote se procesaba de una en una, mucho mas lento. Asi el paralelismo se
   * recupera siempre.
   */
  _ensureWorkers() {
    if (this.paused) return;
    const wanted = this.concurrency - this.activeWorkers;
    if (wanted > 0) {
      const missing = this._countPending(wanted, 'image');
      for (let i = 0; i < missing; i += 1) this._startWorker('image');
    }
    if (this.activeVideoWorkers === 0 && this._countPending(1, 'video') > 0) this._startWorker('video');
    const audioWanted = Math.min(this.concurrency, MAX_AUDIO_WORKERS) - this.activeAudioWorkers;
    if (audioWanted > 0) {
      const missingAudio = this._countPending(audioWanted, 'audio');
      for (let i = 0; i < missingAudio; i += 1) this._startWorker('audio');
    }
  }

  /** Workers en marcha, de todos los carriles. */
  _activeCount() {
    return this.activeWorkers + this.activeVideoWorkers + this.activeAudioWorkers;
  }

  _adjustWorkers(kind, delta) {
    if (kind === 'video') this.activeVideoWorkers += delta;
    else if (kind === 'audio') this.activeAudioWorkers += delta;
    else this.activeWorkers += delta;
  }

  _startWorker(kind) {
    if (this._activeCount() === 0) this._activeSince = Date.now();
    this._adjustWorkers(kind, 1);
    this.isProcessing = true;
    this._worker(kind)
      .catch((err) => console.error('[queue] worker termino con error inesperado:', err))
      .finally(() => {
        this._adjustWorkers(kind, -1);
        if (this._activeCount() === 0) this._onAllWorkersStopped();
      });
  }

  _onAllWorkersStopped() {
    this.isProcessing = false;
    if (this._activeSince !== null) {
      this._activeMs += Date.now() - this._activeSince;
      this._activeSince = null;
    }
    // Red de seguridad: si entro trabajo nuevo justo cuando el ultimo worker
    // se iba, se retoma en vez de dejarlo esperando sin nadie que lo procese.
    if (!this.paused && this._hasPending()) {
      this._ensureWorkers();
      return;
    }
    // La cola se paro (vacia o detenida): momento natural para dejar el
    // registro de "ya procesado" escrito en disco, sin esperar al temporizador.
    manifestStore.flush();
    this.emit('queue-idle', this.getSnapshot());
    const drained = !this.paused && !this._hasPending() && this._importing === 0;
    if (drained) this._finishBatch();
  }

  /**
   * Entrega el resumen del lote SOLO cuando ya no queda nada por hacer. Que
   * la cola se detenga (Detener) no cuenta como "termino": el lote sigue
   * abierto y su conteo se conserva para cuando se reanude y acabe de verdad.
   * (El aviso anterior saltaba al pausar y no al acabar.)
   */
  _finishBatch() {
    const summary = this.batch;
    this.batch = { done: 0, errors: 0, savedBytes: 0 };
    if (summary.done + summary.errors > 0) this.emit('batch-finished', summary);
  }

  /** Cada worker toma trabajos pendientes de SU carril hasta que no queden mas o se pida detener. */
  async _worker(kind) {
    while (!this.paused) {
      const next = this._claimNextPending(kind);
      if (!next) break;
      this._emitUpdate();
      try {
        const settings = loadSettings();
        const report = await processMedia(next.inputPath, next.outputPath, settings, (fraction) => this._onProgress(next, fraction));
        next.status = 'done';
        next.report = report;
        next.progress = null;
        this.batch.done += 1;
        this.batch.savedBytes += report.savedBytes || 0;
        // Ademas de dejar el archivo en output/, se deja constancia en el
        // manifiesto interno (fuera de Documentos, ver manifest-store.js):
        // es lo que evita reprocesar este archivo si en el proximo arranque
        // output/ no esta disponible a tiempo por sincronizacion en la nube.
        manifestStore.markDone(next.inputPath);
      } catch (err) {
        next.status = 'error';
        next.progress = null;
        next.error = err && err.message ? err.message : String(err);
        this.batch.errors += 1;
      }
      this._emitUpdate();
    }
  }

  _onProgress(job, fraction) {
    // Nunca hacia atras: ffmpeg a veces informa un instante menos que antes, y el anillo y la barra retrocedian.
    const rounded = Math.max(job.progress == null ? 0 : job.progress, Math.round(fraction / PROGRESS_STEP) * PROGRESS_STEP);
    if (job.progress === rounded) return;
    job.progress = rounded;
    this._emitUpdate();
  }

  /**
   * Detiene la cola: lo que ya esta a mitad de proceso termina normalmente
   * (no se interrumpe un encode a la mitad; en un video largo eso puede
   * tardar), pero no se empieza nada nuevo. Lo que quedaba pendiente sigue visible en la
   * lista, marcado como "en espera", listo para retomarse.
   */
  pause() {
    if (this.paused) return;
    this.paused = true;
    this._emitUpdate();
  }

  /** Retoma el procesamiento de lo que haya quedado pendiente. */
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this._emitUpdate();
    this._ensureWorkers();
  }

  /**
   * Marca y devuelve el siguiente trabajo pendiente de forma sincrona
   * (sin ningun `await` de por medio), lo que hace imposible que dos
   * workers reclamen el mismo trabajo en el modelo de un solo hilo de JS.
   */
  _claimNextPending(kind = 'image') {
    const jobs = this.jobs;
    let cursor = this._cursors[kind];
    while (cursor < jobs.length && (jobs[cursor].status !== 'pending' || jobKind(jobs[cursor]) !== kind)) cursor += 1;
    if (cursor >= jobs.length) {
      this._cursors[kind] = cursor;
      return null;
    }
    const next = jobs[cursor];
    next.status = 'processing';
    this._cursors[kind] = cursor + 1;
    return next;
  }

  /** ¿Queda algun trabajo pendiente, de cualquier carril? */
  _hasPending() {
    return LANES.some((kind) => this._countPending(1, kind) > 0);
  }

  /** Cuenta pendientes de un carril, deteniendose al llegar a `limit` (no necesita el total exacto). */
  _countPending(limit, kind) {
    let count = 0;
    for (let i = this._cursors[kind]; i < this.jobs.length && count < limit; i += 1) {
      if (this.jobs[i].status === 'pending' && jobKind(this.jobs[i]) === kind) count += 1;
    }
    return count;
  }

  /**
   * Mueve un trabajo PENDIENTE justo antes (o justo despues) de otro pendiente.
   * Lo que ya se esta procesando o termino no se toca. Devuelve true si algo
   * cambio. Los cursores de busqueda se reinician porque asumen que nada
   * anterior a ellos esta pendiente, y aqui un pendiente puede pasar a estar
   * antes: cuesta un recorrido corto la proxima vez y luego vuelve a avanzar.
   */
  moveJob(id, targetId, placeAfter = false) {
    if (id === targetId) return false;
    const from = this.jobs.findIndex((j) => j.id === id);
    const target = this.jobs.find((j) => j.id === targetId);
    if (from < 0 || !target) return false;
    const job = this.jobs[from];
    if (job.status !== 'pending' || target.status !== 'pending') return false;

    this.jobs.splice(from, 1);
    this.jobs.splice(this.jobs.indexOf(target) + (placeAfter ? 1 : 0), 0, job);
    this._cursors = { image: 0, video: 0, audio: 0 };
    this._orderVersion += 1;
    this._emitUpdate();
    return true;
  }

  getSnapshot() {
    // Una sola pasada: construye la lista a enviar y suma lo ahorrado.
    let totalSavedBytes = 0;
    const jobs = new Array(this.jobs.length);
    for (let i = 0; i < this.jobs.length; i += 1) {
      const j = this.jobs[i];
      if (j.status === 'done' && j.report) totalSavedBytes += j.report.savedBytes;
      jobs[i] = {
        id: j.id,
        name: j.name,
        kind: jobKind(j),
        progress: j.progress == null ? null : j.progress,
        inputPath: j.inputPath,
        status: j.status,
        report: j.report,
        error: j.error
      };
    }

    const elapsedMs = this._activeMs + (this._activeSince === null ? 0 : Date.now() - this._activeSince);
    const batchJobs = this.jobs.filter((j) => j.batchId === this._batchId);

    return {
      jobs,
      progress: { ...this._tracker.update(batchJobs, elapsedMs, { importing: this._importing > 0 }), batchId: this._batchId },
      orderVersion: this._orderVersion,
      isProcessing: this.isProcessing,
      paused: this.paused,
      concurrency: this.concurrency,
      totalSavedBytes
    };
  }

  /** Limpia del historial los trabajos ya terminados (done/error), conserva los activos. */
  clearFinished() {
    // Lo terminado del lote en curso sigue contando para su progreso aunque salga de la lista.
    const batchJobs = this.jobs.filter((j) => j.batchId === this._batchId);
    this._tracker.retire(batchJobs, batchJobs);
    this.jobs = this.jobs.filter((j) => j.status === 'pending' || j.status === 'processing');
    this._cursors = { image: 0, video: 0, audio: 0 };
    this._emitUpdate();
  }

  /**
   * Elimina de la cola las imagenes que todavia estaban en espera
   * (pendientes) sin procesar. Es el complemento de resume(): en vez de
   * continuar con lo que quedo pendiente tras pulsar "Detener", el usuario
   * puede descartarlo directamente. La imagen que en ese momento estuviera a
   * mitad de proceso no se toca (termina normalmente, igual que con pause());
   * las ya terminadas (done/error) tampoco se tocan, para eso esta
   * "Limpiar completados". Tras eliminar lo pendiente ya no queda nada que
   * reanudar, asi que se quita el estado de pausa para que la proxima tanda
   * de imagenes que se agregue empiece a procesarse de inmediato.
   *
   * Ademas de sacarlas de la lista en memoria, se borra su copia en
   * `input/`. Es necesario: al arrancar, la app vuelve a encolar
   * automaticamente cualquier imagen de `input/` que no tenga su salida en
   * `output/` (ver `findUnprocessedFiles` en file-manager.js). Si no se
   * borrara el archivo, "Eliminar" solo la ocultaria hasta el proximo
   * reinicio, momento en el que reapareceria sola -- lo cual contradice lo
   * que promete el boton. El original del usuario (si vino de otra carpeta)
   * nunca se toca: `input/` es siempre una copia interna de la app.
   */
  async cancelPending() {
    const toRemove = this.jobs.filter((j) => j.status === 'pending');
    if (toRemove.length === 0) return;
    this.jobs = this.jobs.filter((j) => j.status !== 'pending');
    this._cursors = { image: 0, video: 0, audio: 0 };
    this.paused = false;
    // Si no quedaba ningun worker activo (todo estaba detenido), nadie
    // cerrara el lote despues: se reinicia el conteo aqui, sin avisar (la
    // persona acaba de decidir descartar el resto, ya sabe que termino).
    if (this._activeCount() === 0) this.batch = { done: 0, errors: 0, savedBytes: 0 };
    this._emitUpdate();
    await Promise.all(toRemove.map((job) => fs.unlink(job.inputPath).catch(() => {})));
    toRemove.forEach((job) => manifestStore.forget(job.inputPath));
  }

  /**
   * Avisa de que algo cambio, SIN construir la lista completa: antes cada
   * aviso copiaba todos los trabajos aunque nadie fuera a usarla enseguida
   * (la ventana recibe como mucho un envio cada ~120 ms). Quien necesite el
   * estado lo pide con getSnapshot() en el momento en que lo va a usar.
   */
  _emitUpdate() {
    this.emit('queue-updated');
  }
}

module.exports = new QueueManager();
// Se expone tambien la clase (ademas de la instancia unica de siempre) para
// poder instanciar copias aisladas en las pruebas automatizadas, sin que
// unas pruebas dejen trabajos residuales que afecten a otras.
module.exports.QueueManager = QueueManager;
