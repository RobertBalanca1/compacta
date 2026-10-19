'use strict';

/**
 * Dibuja y actualiza la lista de la cola. Reutiliza los nodos DOM existentes
 * por id de trabajo para que las miniaturas no se recarguen en cada
 * actualizacion y las transiciones CSS se vean fluidas.
 */
(function () {
  const RING_RADIUS = 15;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  // Por que un archivo queda "Sin cambios" (lo dice el procesador en `report.reason`).
  // (clave de idioma de cada motivo; el texto se pide en el momento, porque el idioma puede cambiar)
  const SKIP_REASONS = {
    'ya-optimizado': 'skip.already',
    'sin-mejora-posible': 'skip.noGain',
    'formato-no-soportado': 'skip.unsupported',
    'varios-videos': 'skip.multiVideo',
    'animacion-preservada': 'skip.animation',
    'heic-eficiente': 'skip.heicEfficient'
  };
  const t = (key, params) => window.I18n.t(key, params);
  let lastSnapshot = null;

  const itemElements = new Map();
  const appRoot = document.querySelector('.app');

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
  }

  // La estructura de una fila se parsea UNA vez; despues cada fila nueva es un
  // cloneNode (bastante mas rapido que asignar innerHTML miles de veces).
  const rowTemplate = document.createElement('template');
  rowTemplate.innerHTML = `
    <li>
      <button type="button" class="queue-item__grip" draggable="true" title="Arrastra para cambiar el orden (o Alt + flechas)" aria-label="Mover en la cola: arrastra, o usa Alt y las flechas arriba o abajo" data-i18n-title="queue.gripTitle" data-i18n-aria="queue.gripAria">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.6"></circle><circle cx="15" cy="6" r="1.6"></circle><circle cx="9" cy="12" r="1.6"></circle><circle cx="15" cy="12" r="1.6"></circle><circle cx="9" cy="18" r="1.6"></circle><circle cx="15" cy="18" r="1.6"></circle></svg>
      </button>
      <div class="queue-item__ring-wrap">
        <svg class="queue-item__icon queue-item__icon--image" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2.5"></rect>
          <circle cx="9" cy="10" r="1.9"></circle>
          <path d="M3 16.5l5.2-5 4.3 4 3-2.6L21 17" fill="none"></path>
        </svg>
        <svg class="queue-item__icon queue-item__icon--video" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2.5"></rect>
          <path d="M10 9.2v5.6l4.6-2.8z" class="play"></path>
        </svg>
        <svg class="queue-item__icon queue-item__icon--audio" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9.5 17V6.5l8-1.8v10.8" fill="none"></path>
          <circle cx="7.5" cy="17" r="2.3"></circle>
          <circle cx="15.5" cy="15.3" r="2.3"></circle>
        </svg>
        <svg class="queue-item__ring" viewBox="0 0 38 38">
          <circle class="track" cx="19" cy="19" r="${RING_RADIUS}"></circle>
          <circle class="progress" cx="19" cy="19" r="${RING_RADIUS}"></circle>
        </svg>
      </div>
      <div class="queue-item__info">
        <div class="queue-item__name"></div>
        <div class="queue-item__sub"></div>
      </div>
      <div class="queue-item__badge"></div>
      <button type="button" class="queue-item__preview" title="Ver antes y después" aria-label="Ver antes y después" data-i18n-title="queue.previewTitle" data-i18n-aria="queue.previewTitle">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle></svg>
      </button>
    </li>`;

  function createItemElement(job) {
    const li = rowTemplate.content.firstElementChild.cloneNode(true);
    li.dataset.id = job.id;
    li.dataset.kind = job.kind || 'image'; // decide que icono se ve (ver CSS)
    li.querySelector('.queue-item__name').textContent = job.name;
    // Referencias guardadas una vez: actualizar una fila ya no hace tres
    // querySelector cada vez.
    li._sub = li.querySelector('.queue-item__sub');
    li._badge = li.querySelector('.queue-item__badge');
    li._progress = li.querySelector('.progress');
    translateRow(li);
    return li;
  }

  /** Los textos fijos de una fila (ayudas del asa y del boton de vista previa) en el idioma actual. */
  function translateRow(li) {
    for (const el of li.querySelectorAll('[data-i18n-title]')) el.title = t(el.getAttribute('data-i18n-title'));
    for (const el of li.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
  }

  function updateItemElement(li, job, queuePaused) {
    // Una fila terminada (done/error) ya no cambia nunca, y una pendiente solo
    // cambia al detener/reanudar: si nada de eso cambio, no se toca el DOM.
    // Con la lista llena, la mayoria de las filas se salta en cada envio.
    // Un video en proceso cambia con su porcentaje, asi que el porcentaje
    // entra en la firma; una foto en proceso no tiene nada que actualizar.
    const percent = job.status === 'processing' && job.progress != null ? Math.round(job.progress * 100) : null;
    const signature = job.status === 'pending'
      ? `pending:${queuePaused ? 1 : 0}`
      : (percent === null ? job.status : `processing:${percent}`);
    if (li._signature === signature) return;
    li._signature = signature;

    li.draggable = job.status === 'pending'; // la fila entera se arrastra para reordenar (solo pendientes)
    li.className = `queue-item queue-item--${job.status}${percent === null ? '' : ' queue-item--determinate'}`;
    const sub = li._sub;
    const badge = li._badge;
    const progress = li._progress;

    if (job.status === 'pending') {
      sub.textContent = queuePaused ? t('queue.stopped') : t('queue.waiting');
      badge.textContent = '—';
      progress.style.strokeDasharray = `${RING_CIRCUMFERENCE * 0.15} ${RING_CIRCUMFERENCE}`;
      progress.style.opacity = '0.5';
    } else if (job.status === 'processing') {
      if (percent === null) {
        sub.textContent = t('queue.processing');
        badge.textContent = '…';
        progress.style.strokeDasharray = `${RING_CIRCUMFERENCE * 0.28} ${RING_CIRCUMFERENCE}`;
      } else {
        // Video o audio: el anillo se llena de verdad en vez de girar sin fin.
        sub.textContent = t(job.kind === 'audio' ? 'queue.compressingAudio' : 'queue.compressingVideo', { percent });
        badge.textContent = `${percent}%`;
        progress.style.strokeDasharray = `${RING_CIRCUMFERENCE * Math.max(0.04, percent / 100)} ${RING_CIRCUMFERENCE}`;
      }
      progress.style.opacity = '1';
    } else if (job.status === 'done' && job.report) {
      const { originalBytes, newBytes, savedPercent, skipped, reason, detail } = job.report;
      // Explica el "Sin cambios": no es un fallo, es que no se podia ahorrar sin perder calidad.
      const why = skipped ? (SKIP_REASONS[reason] ? t(SKIP_REASONS[reason]) : '') : detail;
      sub.textContent = `${window.I18n.isolate(`${formatBytes(originalBytes)} → ${formatBytes(newBytes)}`)}${why ? ` · ${why}` : ''}`;
      const grew = !skipped && newBytes > originalBytes; // un HEIC pasado a JPG por compatibilidad
      badge.textContent = skipped ? t('queue.noChange') : grew ? `+${Math.round((newBytes / originalBytes - 1) * 100)}%` : `-${savedPercent}%`;
      progress.style.strokeDasharray = `${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`;
      progress.style.opacity = '1';
    } else if (job.status === 'error') {
      sub.textContent = job.error || t('queue.failed');
      badge.textContent = t('queue.error');
      progress.style.strokeDasharray = `${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`;
      progress.style.opacity = '1';
    }
  }

  function updateQueueControls(snapshot, counts) {
    const pauseResumeBtn = document.getElementById('pauseResumeBtn');
    const cancelPendingBtn = document.getElementById('cancelPendingBtn');
    const hasPending = counts.pending > 0;
    const hasPendingOrActive = hasPending || counts.processing > 0;

    if (!hasPendingOrActive && !snapshot.paused) {
      pauseResumeBtn.classList.add('hidden');
      cancelPendingBtn.classList.add('hidden');
      return;
    }

    pauseResumeBtn.classList.remove('hidden');
    pauseResumeBtn.textContent = snapshot.paused ? t('queue.resume') : t('queue.pause');
    pauseResumeBtn.dataset.action = snapshot.paused ? 'resume' : 'pause';

    // "Eliminar pendientes" solo aparece cuando la cola esta detenida y
    // todavia queda algo en espera que tenga sentido descartar; si no hay
    // pendientes (solo procesando o ya termino todo), no aporta nada.
    cancelPendingBtn.classList.toggle('hidden', !(snapshot.paused && hasPending));
  }

  /**
   * Tiempo restante con la precision que tiene sentido para una ESTIMACION: de 5 en 5
   * segundos, luego minutos y segundos de 10 en 10, y despues solo minutos. Una cifra
   * "exacta" que baja a saltos da mas sensacion de error que una redondeada.
   */
  function formatEta(ms) {
    const totalSeconds = Math.max(1, Math.round(ms / 1000));
    if (totalSeconds < 10) return t('eta.lessThan10');
    if (totalSeconds < 60) return t('eta.seconds', { s: Math.max(10, Math.round(totalSeconds / 5) * 5) });
    if (totalSeconds < 600) {
      let minutes = Math.floor(totalSeconds / 60);
      let seconds = Math.round((totalSeconds % 60) / 10) * 10;
      if (seconds === 60) {
        minutes += 1;
        seconds = 0;
      }
      return seconds === 0 ? t('eta.minutes', { m: minutes }) : t('eta.minutesSeconds', { m: minutes, s: seconds });
    }
    const totalMinutes = Math.round(totalSeconds / 60);
    if (totalMinutes < 60) return t('eta.minutes', { m: totalMinutes });
    let hours = Math.floor(totalMinutes / 60);
    let minutes = Math.round((totalMinutes % 60) / 5) * 5;
    if (minutes === 60) {
      hours += 1;
      minutes = 0;
    }
    return t('eta.hoursMinutes', { h: hours, m: String(minutes).padStart(2, '0') });
  }

  let hideProgressTimer = null;
  let finishedBatchShown = null; // lote cuya barra "Terminado" ya esta programada para retirarse
  let dismissedBatch = null; // lote cuya barra ya se retiro: no vuelve a salir sola

  /** Barra global del lote: hechos de total, y tiempo restante cuando ya se puede estimar. */
  function renderGlobalProgress(progress, hasJobs) {
    const box = document.getElementById('globalProgress');
    // Un solo trabajo no necesita barra global (su propia fila ya lo dice). Sin nada en la lista
    // (se limpio) tampoco, y una barra ya retirada no reaparece por cada aviso posterior.
    const relevant = progress && progress.total > 1 && hasJobs && progress.batchId !== dismissedBatch;
    if (!relevant) {
      box.classList.add('hidden');
      return;
    }
    const finished = progress.finished === true;
    box.classList.remove('hidden');
    box.classList.toggle('complete', finished);
    const percent = Math.round(progress.fraction * 100);
    document.getElementById('globalProgressFill').style.width = `${percent}%`;
    box.setAttribute('aria-valuenow', String(percent));

    const count = t('progress.count', { done: progress.done + progress.errors, total: progress.total, more: progress.importing ? '+' : '' });
    let text;
    if (finished) text = t('progress.finished', { count });
    else if (progress.importing) text = progress.etaMs === null ? t('progress.importing', { count }) : t('progress.importingEta', { count, eta: formatEta(progress.etaMs) });
    else if (progress.etaMs === null) text = t('progress.calculating', { count });
    else text = t('progress.remaining', { count, eta: formatEta(progress.etaMs) });
    document.getElementById('globalProgressText').textContent = text;

    // Terminado: se deja verse un momento y se retira solo (una sola vez por lote).
    if (finished && finishedBatchShown !== progress.batchId) {
      finishedBatchShown = progress.batchId;
      clearTimeout(hideProgressTimer);
      hideProgressTimer = setTimeout(() => {
        box.classList.add('hidden');
        dismissedBatch = progress.batchId;
      }, 6000);
    } else if (!finished) {
      clearTimeout(hideProgressTimer);
      finishedBatchShown = null;
    }
  }

  // Version del orden que se pinto por ultima vez: si cambia, se recolocan las filas.
  let renderedOrderVersion;

  function render(snapshot) {
    lastSnapshot = snapshot;
    const list = document.getElementById('queueList');
    const empty = document.getElementById('emptyState');
    const counts = { pending: 0, processing: 0 };
    const fresh = document.createDocumentFragment();

    for (const job of snapshot.jobs) {
      if (job.status === 'pending') counts.pending += 1;
      else if (job.status === 'processing') counts.processing += 1;

      let li = itemElements.get(job.id);
      if (!li) {
        li = createItemElement(job);
        itemElements.set(job.id, li);
        // Los nuevos se acumulan y se insertan de una vez: un solo reflujo
        // en vez de uno por fila. Los trabajos nunca cambian de orden, asi
        // que los ya existentes no se mueven.
        fresh.appendChild(li);
      }
      updateItemElement(li, job, snapshot.paused);
    }
    if (fresh.childNodes.length > 0) list.appendChild(fresh);

    // Se reordeno a mano: las filas existentes se recolocan en el orden nuevo.
    // (Normalmente los trabajos solo se anaden al final y nada se mueve.)
    if (renderedOrderVersion !== undefined && snapshot.orderVersion !== renderedOrderVersion) {
      // Mover un elemento en el DOM le quita el foco: si alguien estaba usando el
      // teclado sobre el asa de una fila, se le devuelve (si no, la siguiente
      // pulsacion de Alt + flecha ya no llegaria a ningun sitio).
      const focusedRow = document.activeElement && document.activeElement.closest ? document.activeElement.closest('#queueList li') : null;
      const focusedWasGrip = !!focusedRow && document.activeElement.classList.contains('queue-item__grip');
      const ordered = document.createDocumentFragment();
      for (const job of snapshot.jobs) ordered.appendChild(itemElements.get(job.id));
      list.appendChild(ordered);
      if (focusedWasGrip) focusedRow.querySelector('.queue-item__grip').focus({ preventScroll: false });
    }
    renderedOrderVersion = snapshot.orderVersion;

    // El mapa solo contiene ids que se han visto alguna vez: si tiene mas
    // entradas que la lista actual, sobran (se limpiaron trabajos). Si no,
    // no hace falta recorrer nada.
    if (itemElements.size > snapshot.jobs.length) {
      const current = new Set();
      for (const job of snapshot.jobs) current.add(job.id);
      for (const [id, el] of itemElements) {
        if (!current.has(id)) {
          el.remove();
          itemElements.delete(id);
        }
      }
    }

    empty.classList.toggle('hidden', snapshot.jobs.length > 0);
    // Con algo en la cola, la zona de arrastrar se vuelve una franja compacta (ver CSS "Ventana que NO esta maximizada").
    appRoot.classList.toggle('has-queue', snapshot.jobs.length > 0);
    renderGlobalProgress(snapshot.progress, snapshot.jobs.length > 0);
    document.getElementById('savedTotal').textContent = t('queue.saved', { size: window.I18n.isolate(formatBytes(snapshot.totalSavedBytes)) });
    updateQueueControls(snapshot, counts);
  }

  /** Cambio de idioma: se vuelven a escribir todas las filas y los textos de la cabecera de la cola. */
  function refresh() {
    for (const li of itemElements.values()) {
      li._signature = null;
      translateRow(li);
    }
    if (lastSnapshot) render(lastSnapshot);
    else document.getElementById('savedTotal').textContent = t('queue.saved', { size: window.I18n.isolate(formatBytes(0)) });
  }

  window.QueueView = { render, refresh, formatBytes, formatEta };
})();
