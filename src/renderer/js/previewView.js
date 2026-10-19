'use strict';

/**
 * Vista previa "antes y despues" de una foto procesada. Se abre desde el boton
 * del ojo de una fila terminada. La foto llega ya reducida desde el proceso
 * principal (ver src/main/preview.js): aqui nunca se carga la original completa.
 *
 * Dos vistas:
 *  - Foto completa: la original y el resultado superpuestos con una linea que se
 *    arrastra (con el raton, el dedo o el deslizador de abajo). A la izquierda de la
 *    linea se ve la original; a la derecha, la comprimida.
 *  - Detalle al 100 %: una zona de la foto SIN reducir. Es la que deja ver lo que de
 *    verdad cambio: con una compresion buena, la foto completa se ve igual a este
 *    tamano y por eso "no pasaba nada" al mover la linea.
 */
(function () {
  const overlay = document.getElementById('previewOverlay');
  const status = document.getElementById('previewStatus');
  const body = document.getElementById('previewBody');
  const wrap = document.getElementById('previewStageWrap');
  const stage = document.getElementById('previewStage');
  const slider = document.getElementById('previewSlider');
  const imgBefore = document.getElementById('previewBefore');
  const imgAfter = document.getElementById('previewAfter');
  const zoomBtn = document.getElementById('previewZoomBtn');
  const hint = document.getElementById('previewHint');
  const busy = document.getElementById('previewBusy');
  const minimap = document.getElementById('previewMinimap');
  const minimapImg = document.getElementById('previewMinimapImg');
  const minimapBox = document.getElementById('previewMinimapBox');

  // Alto que ocupa todo lo que NO es la foto (cabecera, deslizador, textos, margenes).
  const PANEL_CHROME_PX = 250;
  const MAX_STAGE_HEIGHT_PX = 760;
  const DETAIL_MAX_HEIGHT_PX = 560;

  let openToken = 0; // si se cierra y se abre otra mientras carga, la respuesta vieja se ignora
  let currentJobId = null;
  let overview = null; // lo que llego de buildPreview
  let mode = 'overview'; // 'overview' | 'detail'
  let focus = { x: 0.5, y: 0.5 }; // por donde miraba la persona (0..1), para centrar el detalle
  let detailInFlight = false;
  let detailQueued = null;
  let dragging = false;

  const t = (key, params) => window.I18n.t(key, params);

  function dimensions(side) {
    return `${side.width}×${side.height}`;
  }

  function clamp01(value) {
    return Math.min(1, Math.max(0, value));
  }

  // ----- Tamano del escenario -----
  function availableBox() {
    const maxW = Math.max(240, wrap.clientWidth || 600);
    const maxH = Math.max(200, Math.min(MAX_STAGE_HEIGHT_PX, window.innerHeight - PANEL_CHROME_PX));
    return { maxW, maxH };
  }

  function sizeStage(width, height) {
    stage.style.width = `${Math.round(width)}px`;
    stage.style.height = `${Math.round(height)}px`;
    // El deslizador mide lo mismo que la foto: asi su recorrido coincide con el de la linea.
    slider.style.width = `${Math.round(width)}px`;
  }

  /** Foto completa: el escenario tiene EXACTAMENTE la proporcion de la foto, asi la linea recorre la foto y no un marco vacio. */
  function layoutOverview() {
    if (!overview) return;
    const ratio = overview.after.previewWidth / overview.after.previewHeight;
    const { maxW, maxH } = availableBox();
    const width = Math.min(maxW, maxH * ratio);
    sizeStage(width, width / ratio);
  }

  // ----- Linea divisoria -----
  function setSplit(value) {
    const v = Math.min(100, Math.max(0, Number(value)));
    stage.style.setProperty('--split', `${v}%`);
    slider.value = String(Math.round(v));
  }

  function splitFromPointer(event) {
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0) return;
    setSplit(((event.clientX - rect.left) / rect.width) * 100);
  }

  function focusFromPointer(event) {
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    focus = { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01((event.clientY - rect.top) / rect.height) };
  }

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    dragging = true;
    try { stage.setPointerCapture(event.pointerId); } catch { /* no pasa nada: se sigue sin captura */ }
    if (mode === 'overview') focusFromPointer(event);
    splitFromPointer(event);
    event.preventDefault();
  });
  stage.addEventListener('pointermove', (event) => {
    if (mode === 'overview') focusFromPointer(event);
    if (dragging) splitFromPointer(event);
  });
  const endDrag = (event) => {
    dragging = false;
    try { stage.releasePointerCapture(event.pointerId); } catch { /* ya soltado */ }
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', (event) => {
    if (mode !== 'overview') return;
    focusFromPointer(event);
    enterDetail();
  });
  slider.addEventListener('input', () => setSplit(slider.value));

  // ----- Detalle al 100 % -----
  function showMinimapBox(region, imageWidth, imageHeight) {
    minimapBox.style.left = `${(region.left / imageWidth) * 100}%`;
    minimapBox.style.top = `${(region.top / imageHeight) * 100}%`;
    minimapBox.style.width = `${(region.width / imageWidth) * 100}%`;
    minimapBox.style.height = `${(region.height / imageHeight) * 100}%`;
  }

  async function requestDetail(center) {
    if (detailInFlight) {
      detailQueued = center; // gana la ultima peticion; las intermedias no hace falta hacerlas
      return;
    }
    detailInFlight = true;
    const token = openToken;
    busy.classList.remove('hidden');
    try {
      const dpr = window.devicePixelRatio || 1;
      const { maxW, maxH } = availableBox();
      const boxH = Math.min(maxH, DETAIL_MAX_HEIGHT_PX);
      // Pixeles REALES de la pantalla: con una pantalla de alta densidad, 100 % son mas pixeles que puntos CSS.
      const result = await window.api.getPreviewDetail(currentJobId, {
        cx: center.x,
        cy: center.y,
        width: Math.floor(maxW * dpr),
        height: Math.floor(boxH * dpr)
      });
      if (token !== openToken || mode !== 'detail') return;
      imgBefore.src = result.before;
      imgAfter.src = result.after;
      sizeStage(result.region.width / dpr, result.region.height / dpr);
      showMinimapBox(result.region, result.imageWidth, result.imageHeight);
    } catch (err) {
      if (token !== openToken) return;
      hint.textContent = String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
      exitDetail();
    } finally {
      detailInFlight = false;
      busy.classList.add('hidden');
      if (detailQueued && token === openToken && mode === 'detail') {
        const next = detailQueued;
        detailQueued = null;
        requestDetail(next);
      } else {
        detailQueued = null;
      }
    }
  }

  function enterDetail() {
    if (!overview || overview.video || mode === 'detail') return;
    mode = 'detail';
    zoomBtn.textContent = t('preview.zoomOff');
    zoomBtn.setAttribute('aria-pressed', 'true');
    hint.textContent = t('preview.hintDetail');
    minimapImg.src = overview.before.dataUrl;
    minimap.style.aspectRatio = `${overview.before.previewWidth} / ${overview.before.previewHeight}`;
    minimap.classList.remove('hidden');
    requestDetail(focus);
  }

  function exitDetail() {
    if (!overview) return;
    mode = 'overview';
    detailQueued = null;
    zoomBtn.textContent = t('preview.zoom');
    zoomBtn.setAttribute('aria-pressed', 'false');
    hint.textContent = overview.video ? t('preview.hintVideo') : t('preview.hintOverview');
    minimap.classList.add('hidden');
    busy.classList.add('hidden');
    imgBefore.src = overview.before.dataUrl;
    imgAfter.src = overview.after.dataUrl;
    layoutOverview();
  }

  function toggleDetail() {
    if (mode === 'detail') exitDetail();
    else enterDetail();
  }
  zoomBtn.addEventListener('click', toggleDetail);

  // Mapa pequeño: tocar o arrastrar cambia la zona que se ve al 100 %.
  let draggingMap = false;
  function centerFromMap(event) {
    const rect = minimap.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    focus = { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01((event.clientY - rect.top) / rect.height) };
    requestDetail(focus);
  }
  minimap.addEventListener('pointerdown', (event) => {
    draggingMap = true;
    try { minimap.setPointerCapture(event.pointerId); } catch { /* sin captura tambien funciona */ }
    centerFromMap(event);
    event.preventDefault();
  });
  minimap.addEventListener('pointermove', (event) => {
    if (draggingMap) centerFromMap(event);
  });
  const endMapDrag = (event) => {
    draggingMap = false;
    try { minimap.releasePointerCapture(event.pointerId); } catch { /* ya soltado */ }
  };
  minimap.addEventListener('pointerup', endMapDrag);
  minimap.addEventListener('pointercancel', endMapDrag);

  // ----- Abrir / cerrar -----
  function close() {
    openToken += 1;
    overlay.classList.add('hidden');
    mode = 'overview';
    overview = null;
    currentJobId = null;
    detailInFlight = false;
    detailQueued = null;
    dragging = false;
    draggingMap = false;
    // Se sueltan las imagenes: dos fotos de 1400 px en memoria (o dos recortes grandes) no deben quedarse colgadas.
    imgBefore.removeAttribute('src');
    imgAfter.removeAttribute('src');
    minimapImg.removeAttribute('src');
    minimap.classList.add('hidden');
    busy.classList.add('hidden');
    zoomBtn.classList.add('hidden');
  }

  async function open(jobId) {
    const token = (openToken += 1);
    currentJobId = jobId;
    overview = null;
    mode = 'overview';
    focus = { x: 0.5, y: 0.5 };
    overlay.classList.remove('hidden');
    body.classList.add('hidden');
    zoomBtn.classList.add('hidden');
    zoomBtn.textContent = t('preview.zoom');
    zoomBtn.setAttribute('aria-pressed', 'false');
    minimap.classList.add('hidden');
    status.classList.remove('hidden');
    status.textContent = t('preview.preparing');
    setSplit(50);
    slider.focus({ preventScroll: true });

    let data;
    try {
      data = await window.api.getPreview(jobId);
    } catch (err) {
      if (token !== openToken) return;
      // Electron antepone "Error invoking remote method…": se muestra solo el mensaje util.
      status.textContent = String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
      return;
    }
    if (token !== openToken) return;

    overview = data;
    imgBefore.src = data.before.dataUrl;
    imgAfter.src = data.after.dataUrl;
    const fmt = window.QueueView.formatBytes;
    const saved = data.before.bytes > 0 ? Math.round((1 - data.after.bytes / data.before.bytes) * 100) : 0;
    document.getElementById('previewBeforeStats').textContent = t('preview.statOriginal', { dims: window.I18n.isolate(dimensions(data.before)), size: window.I18n.isolate(fmt(data.before.bytes)) });
    document.getElementById('previewAfterStats').textContent = t('preview.statResult', { dims: window.I18n.isolate(dimensions(data.after)), size: window.I18n.isolate(fmt(data.after.bytes)), saved: saved > 0 ? ` (−${saved}%)` : '' });
    hint.textContent = data.video ? t('preview.hintVideo') : t('preview.hintOverview');
    document.getElementById('previewTitle').textContent = t(data.video ? 'preview.titleVideo' : 'preview.title');
    status.classList.add('hidden');
    body.classList.remove('hidden');
    zoomBtn.classList.toggle('hidden', data.video === true); // el detalle al 100 % es solo de fotos
    layoutOverview(); // despues de mostrar el cuerpo: antes no se puede medir el ancho disponible
  }

  window.addEventListener('resize', () => {
    if (overview && mode === 'overview' && !overlay.classList.contains('hidden')) layoutOverview();
  });
  document.getElementById('closePreviewBtn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close(); // clic fuera del panel
  });
  document.addEventListener('keydown', (e) => {
    if (overlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') close();
    else if ((e.key === 'z' || e.key === 'Z') && !e.ctrlKey && !e.metaKey && !e.altKey && overview && !overview.video) toggleDetail();
  });

  // Un solo escuchador para toda la lista (no uno por fila).
  document.getElementById('queueList').addEventListener('click', (e) => {
    const button = e.target.closest('.queue-item__preview');
    if (!button) return;
    const row = button.closest('li');
    if (row && row.dataset.id) open(row.dataset.id);
  });

  window.PreviewView = { open, close };
})();
