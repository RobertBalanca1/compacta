'use strict';

const { t } = require('../shared/i18n');
const { applyLanguage, describeLanguage } = require('./language');
const { refreshAppMenu } = require('./app-menu');

const fs = require('fs');
const { ipcMain, dialog, shell } = require('electron');
const { importPaths, importClipboardImage } = require('./importer');
const { getOutputPathFor, hasOutputFor } = require('./file-manager');
const { loadSettings, saveSettings, createProfile, renameProfile, deleteProfile, switchProfile } = require('./settings-store');
const { getOutputDir, isBaseDirCloudSynced } = require('./paths');
const { buildPreview, buildDetail } = require('./preview');
const { applyConfiguredOutputDir, chooseOutputDir, resetOutputDir, describeOutputDirWhenReady } = require('./output-dir');
const { SUPPORTED_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, ARCHIVE_EXTENSIONS } = require('./processor/formats');
const queueManager = require('./queue-manager');
const notifier = require('./notifier');

// Sale de la misma lista que usa el motor: antes esto era una segunda copia
// escrita a mano que podia quedar desactualizada al anadir un formato.
const toDialogExtensions = (set) => [...set].map((ext) => ext.slice(1));
const IMAGE_EXTENSIONS = toDialogExtensions(SUPPORTED_EXTENSIONS);
const VIDEO_DIALOG_EXTENSIONS = toDialogExtensions(VIDEO_EXTENSIONS);
const AUDIO_DIALOG_EXTENSIONS = toDialogExtensions(AUDIO_EXTENSIONS);
const ARCHIVE_DIALOG_EXTENSIONS = toDialogExtensions(ARCHIVE_EXTENSIONS);
// Se calculan al abrir el selector, no al cargar el modulo: el idioma puede cambiarse en Ajustes.
const imageDialogFilters = () => [
  { name: t('dialog.filterAll'), extensions: [...IMAGE_EXTENSIONS, ...VIDEO_DIALOG_EXTENSIONS, ...AUDIO_DIALOG_EXTENSIONS, ...ARCHIVE_DIALOG_EXTENSIONS] },
  { name: t('dialog.filterImages'), extensions: IMAGE_EXTENSIONS },
  { name: t('dialog.filterVideos'), extensions: VIDEO_DIALOG_EXTENSIONS },
  { name: t('dialog.filterAudios'), extensions: AUDIO_DIALOG_EXTENSIONS },
  { name: t('dialog.filterArchives'), extensions: ARCHIVE_DIALOG_EXTENSIONS }
];

const EMPTY_IMPORT_RESULT = Object.freeze({
  importedCount: 0, skippedCount: 0, skippedExtensions: [], failedCount: 0, duplicateCount: 0, duplicateInDrop: 0, duplicateBefore: 0, duplicateRetryable: 0, archiveCount: 0, failedArchives: [], canceled: true
});

// Minimo de milisegundos entre dos envios de la lista a la ventana. Cada
// cambio de cualquier foto reenvia la lista COMPLETA; con lotes de miles de
// fotos eso eran millones de objetos copiados por segundo y la interfaz se
// congelaba. Se junta todo en un envio cada ~120 ms; el ultimo estado
// siempre llega.
const QUEUE_UPDATE_INTERVAL_MS = 120;
// Con listas muy grandes cada envio cuesta mas (se copia la lista entera);
// se espacian mas los envios para que la interfaz nunca se ahogue.
const QUEUE_UPDATE_INTERVAL_LARGE_MS = 300;
const LARGE_QUEUE_THRESHOLD = 2000;

function assertStringArray(value) {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(t('ipc.invalidList'));
  }
}

/**
 * Para la deteccion de duplicados: ¿el trabajo de este archivo de input/ sigue vivo? Si esta en la
 * cola (esperando, en curso o terminado) o su resultado esta en la carpeta de salida, si. Si dio error
 * o su resultado ya no existe, no: soltarlo otra vez debe procesarse (ver duplicates.js).
 *
 * Se crea UNA vez por importacion: la lista de la cola se convierte en un conjunto (buscar en la
 * lista entera por cada archivo era cuadratico: con 20.000 en cola, 400 millones de comparaciones
 * que dejaban la app congelada) y cada carpeta de salida se lista una sola vez.
 */
function createLivenessCheck() {
  const queued = new Set();
  for (const job of queueManager.jobs) if (job.status !== 'error') queued.add(job.inputPath);
  const outputListings = new Map();
  return async (inputPath) => queued.has(inputPath) || hasOutputFor(inputPath, outputListings);
}

// Lo omitido por repetido en la ultima importacion, por si la persona pulsa "Procesar de todos modos".
let lastSkippedSources = [];

/**
 * Importa rutas (archivos, varias carpetas, ZIPs) y encola las imagenes
 * resultantes. Se encolan carpeta a carpeta MIENTRAS se sigue importando:
 * la primera carpeta ya se esta comprimiendo mientras se copia la segunda,
 * en vez de esperar a que termine toda la copia (tiempo muerto antes).
 * `onProgress(n)` informa a la ventana de cuantas imagenes van importadas.
 */
async function importAndEnqueue(paths, onProgress, { allowDuplicates = false, password = null } = {}) {
  assertStringArray(paths);
  let imported = 0;
  if (onProgress) onProgress(0); // "ya empezo": la ventana pasa a mostrar "Importando…"
  // Mientras se importa, el lote de la cola sigue abierto aunque se vaya vaciando
  // entre una carpeta y la siguiente (si no, la barra global volvia a cero).
  queueManager.beginImport();
  let output;
  let result;
  try {
    // Si la carpeta de salida elegida ya no esta disponible (disco desenchufado),
    // se usa la de siempre ANTES de calcular ninguna ruta de salida, y se avisa.
    output = await applyConfiguredOutputDir();
    result = await importPaths(paths, {
      isLive: createLivenessCheck(),
      allowDuplicates,
      password,
      onFiles: (files) => {
        queueManager.addJobs(files.map((inputPath) => ({ inputPath, outputPath: getOutputPathFor(inputPath) })));
        imported += files.length;
        if (onProgress) onProgress(imported);
      }
    });
  } finally {
    queueManager.endImport();
  }
  // Solo se recuerda lo ultimo omitido; al procesarlo de todos modos se olvida.
  if (allowDuplicates) lastSkippedSources = [];
  else if (result.duplicateSources.length > 0) lastSkippedSources = result.duplicateSources;
  return {
    importedCount: result.importedFiles.length,
    skippedCount: result.skippedCount,
    skippedExtensions: result.skippedExtensions,
    failedCount: result.failedCount,
    duplicateCount: result.duplicateCount,
    duplicateInDrop: result.duplicateInDrop,
    duplicateBefore: result.duplicateBefore,
    duplicateRetryable: allowDuplicates ? 0 : result.duplicateSources.length,
    archiveCount: result.archiveCount,
    failedArchives: result.failedArchives,
    outputDir: output.dir,
    outputFellBackFrom: output.fellBackFrom,
    canceled: false
  };
}

/** Reenvia a la ventana los cambios de la cola (con freno, para no saturarla en lotes grandes) y avisa al terminar un lote. */
function forwardQueueEvents(currentWindow) {
  let updateTimer = null;
  let lastUpdateSentAt = 0;
  queueManager.on('queue-updated', () => {
    if (updateTimer) return;
    const interval = queueManager.jobs.length > LARGE_QUEUE_THRESHOLD ? QUEUE_UPDATE_INTERVAL_LARGE_MS : QUEUE_UPDATE_INTERVAL_MS;
    const wait = Math.max(0, interval - (Date.now() - lastUpdateSentAt));
    updateTimer = setTimeout(() => {
      updateTimer = null;
      lastUpdateSentAt = Date.now();
      const win = currentWindow();
      if (win) win.webContents.send('queue:update', queueManager.getSnapshot());
    }, wait);
  });

  queueManager.on('batch-finished', (summary) => {
    notifier.announceBatchFinished(summary, currentWindow());
  });
}

/** Cola: pausar, reanudar, cancelar, reordenar y limpiar. */
function registerQueueHandlers() {
  ipcMain.handle('queue:get-snapshot', () => queueManager.getSnapshot());
  ipcMain.handle('queue:clear-finished', () => {
    queueManager.clearFinished();
    return queueManager.getSnapshot();
  });
  ipcMain.handle('queue:move-job', (_event, jobId, targetId, placeAfter) => {
    if (typeof jobId !== 'string' || typeof targetId !== 'string') return false;
    return queueManager.moveJob(jobId, targetId, placeAfter === true);
  });
  ipcMain.handle('queue:pause', () => {
    queueManager.pause();
    return queueManager.getSnapshot();
  });
  ipcMain.handle('queue:resume', () => {
    queueManager.resume();
    return queueManager.getSnapshot();
  });
  ipcMain.handle('queue:cancel-pending', async () => {
    await queueManager.cancelPending();
    return queueManager.getSnapshot();
  });
}

/**
 * Importar: arrastrar, elegir archivos/carpetas/comprimidos y pegar una captura.
 * `ctx`: { importFromPaths, sendImportProgress, showOpenDialog } (ver setupIpcHandlers).
 */
function registerImportHandlers({ importFromPaths, sendImportProgress, showOpenDialog }) {
  ipcMain.handle('batches:import-paths', async (_event, paths) => importFromPaths(paths));

  // "Procesar de todos modos": vuelve a importar lo que se omitio por repetido, SIN tocar el ajuste.
  // La ventana no manda rutas: el proceso principal usa las que el mismo recordo.
  ipcMain.handle('batches:import-skipped', async () => {
    const sources = lastSkippedSources;
    lastSkippedSources = [];
    if (sources.length === 0) return { ...EMPTY_IMPORT_RESULT, canceled: false };
    return importAndEnqueue(sources, sendImportProgress, { allowDuplicates: true });
  });

  // ZIP con contrasena: la ventana la pide a la persona y reintenta SOLO ese comprimido. La contrasena viaja
  // una vez, se usa durante la importacion y no se guarda en ningun sitio.
  ipcMain.handle('batches:import-archive-password', async (_event, archivePath, password) => {
    if (typeof archivePath !== 'string' || typeof password !== 'string' || password.length === 0) throw new Error(t('ipc.invalidList'));
    return importAndEnqueue([archivePath], sendImportProgress, { password });
  });

  ipcMain.handle('clipboard:import-image', async (_event, bytes, extension) => {
    await applyConfiguredOutputDir(); // disco desenchufado -> carpeta de siempre, antes de calcular rutas
    const buffer = Buffer.from(bytes);
    const result = await importClipboardImage(buffer, extension, { isLive: createLivenessCheck() });
    if (result.importedFiles.length > 0) {
      const pairs = result.importedFiles.map((inputPath) => ({ inputPath, outputPath: getOutputPathFor(inputPath) }));
      queueManager.addJobs(pairs);
    }
    // Se devuelve tambien lo omitido por repetido: antes una captura repetida no hacia NADA y sin aviso.
    return {
      importedCount: result.importedFiles.length,
      duplicateCount: result.duplicateCount,
      duplicateInDrop: result.duplicateInDrop,
      duplicateBefore: result.duplicateBefore
    };
  });

  ipcMain.handle('dialog:select-files', async () => {
    const result = await showOpenDialog({
      title: t('dialog.pickMedia'),
      properties: ['openFile', 'multiSelections'],
      filters: imageDialogFilters()
    });
    if (result.canceled) return EMPTY_IMPORT_RESULT;
    return importFromPaths(result.filePaths);
  });

  ipcMain.handle('dialog:select-archive', async () => {
    const result = await showOpenDialog({
      title: t('dialog.pickArchives'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: t('dialog.filterArchivesLong'), extensions: ARCHIVE_DIALOG_EXTENSIONS }]
    });
    if (result.canceled) return EMPTY_IMPORT_RESULT;
    return importFromPaths(result.filePaths);
  });

  ipcMain.handle('dialog:select-folder', async () => {
    const result = await showOpenDialog({
      title: t('dialog.pickFolders'),
      // multiSelections: se pueden elegir varias carpetas de una vez
      // (Ctrl/Cmd + clic en el selector del sistema).
      properties: ['openDirectory', 'multiSelections']
    });
    if (result.canceled) return EMPTY_IMPORT_RESULT;
    return importFromPaths(result.filePaths);
  });
}

/** Ajustes y perfiles. */
function registerSettingsHandlers() {
  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:save', (_event, partial) => {
    const saved = saveSettings(partial);
    if (partial && typeof partial === 'object' && 'language' in partial) {
      applyLanguage(); // idioma nuevo para los avisos de este proceso
      refreshAppMenu(); // y para el menu de macOS
    }
    return saved;
  });
  ipcMain.handle('language:get', () => describeLanguage());
  ipcMain.handle('profiles:create', (_event, name, overrides) => createProfile(name, overrides));
  ipcMain.handle('profiles:rename', (_event, id, name) => renameProfile(id, name));
  ipcMain.handle('profiles:delete', (_event, id) => deleteProfile(id));
  ipcMain.handle('profiles:switch', (_event, id) => switchProfile(id));
}

/** Carpeta de salida: abrirla, ver, elegir otra y volver a la de siempre. */
function registerOutputHandlers({ showOpenDialog }) {
  // Antes el resultado de openPath se ignoraba: si la carpeta de salida no
  // existia todavia (nada procesado aun), el boton "Abrir carpeta de salida"
  // no hacia nada y sin ningun mensaje.
  ipcMain.handle('output:open', async () => {
    fs.mkdirSync(getOutputDir(), { recursive: true });
    const error = await shell.openPath(getOutputDir());
    if (error) throw new Error(error);
  });

  // Carpeta de salida elegible (ver output-dir.js).
  ipcMain.handle('output:get', () => describeOutputDirWhenReady());
  ipcMain.handle('output:choose', async () => {
    const result = await showOpenDialog({
      title: t('output.pickTitle'),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: t('output.pickButton')
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
    return chooseOutputDir(result.filePaths[0]);
  });
  ipcMain.handle('output:reset', () => resetOutputDir());
}

/** Vista previa antes/despues de una foto. */
function registerPreviewHandlers() {
  // Vista previa antes/despues de UNA foto (ver preview.js). Se pide por id de
  // trabajo, nunca por ruta: la ventana no decide que archivo se lee.
  ipcMain.handle('preview:get', async (_event, jobId) => {
    const job = queueManager.jobs.find((j) => j.id === jobId);
    return buildPreview(job);
  });
  // Detalle al 100 % de una zona (ver buildDetail). La zona la pide la ventana, pero
  // se valida y se acota alli: nunca decide una ruta.
  ipcMain.handle('preview:detail', async (_event, jobId, request) => {
    const job = queueManager.jobs.find((j) => j.id === jobId);
    return buildDetail(job, request);
  });
}

/** Avisos de la propia app. */
function registerAppHandlers() {
  ipcMain.handle('app:cloud-sync-check', () => {
    const settings = loadSettings();
    return { cloudSynced: isBaseDirCloudSynced(), dismissed: !!settings.dismissedCloudWarning };
  });
  ipcMain.handle('app:dismiss-cloud-warning', () => saveSettings({ dismissedCloudWarning: true }));
}

/**
 * Se llama UNA sola vez al arrancar. Recibe una funcion (no la ventana) porque
 * en macOS cerrar la ventana no cierra la app: al pulsar el icono del Dock se
 * crea una ventana NUEVA. Antes los manejadores quedaban atados a la primera
 * ventana (ya destruida), asi que la nueva no recibia el progreso de la cola
 * y los botones de elegir archivos/carpeta fallaban con "Object has been
 * destroyed". Preguntando por la ventana actual en cada momento, funciona
 * igual con la primera que con las siguientes.
 */
function setupIpcHandlers(getMainWindow) {
  const currentWindow = () => {
    const win = getMainWindow();
    return win && !win.isDestroyed() ? win : null;
  };

  forwardQueueEvents(currentWindow);

  const sendImportProgress = (count) => {
    const win = currentWindow();
    if (win) win.webContents.send('import:progress', count);
  };
  const importFromPaths = (paths) => importAndEnqueue(paths, sendImportProgress);

  const showOpenDialog = (options) => {
    const win = currentWindow();
    return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
  };

  registerQueueHandlers();
  registerImportHandlers({ importFromPaths, sendImportProgress, showOpenDialog });
  registerSettingsHandlers();
  registerOutputHandlers({ showOpenDialog });
  registerPreviewHandlers();
  registerAppHandlers();
}

module.exports = { setupIpcHandlers };
