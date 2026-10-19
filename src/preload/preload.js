'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Sistema operativo ('darwin' = Mac, 'win32', 'linux'): la interfaz se adapta (hueco para los botones de la ventana
  // de Mac, ⌘V en vez de Ctrl+V).
  platform: process.platform,
  // Entrar/salir de pantalla completa (en Mac los botones de la ventana se esconden)
  onFullScreenChange: (callback) => {
    const listener = (_event, on) => callback(!!on);
    ipcRenderer.on('window:fullscreen', listener);
    return () => ipcRenderer.removeListener('window:fullscreen', listener);
  },

  // Importar imagenes
  importFiles: (paths) => ipcRenderer.invoke('batches:import-paths', paths),
  importSkipped: () => ipcRenderer.invoke('batches:import-skipped'),
  importArchiveWithPassword: (archivePath, password) => ipcRenderer.invoke('batches:import-archive-password', archivePath, password),
  importClipboardImage: (bytes, extension) => ipcRenderer.invoke('clipboard:import-image', bytes, extension),
  selectFiles: () => ipcRenderer.invoke('dialog:select-files'),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  selectArchive: () => ipcRenderer.invoke('dialog:select-archive'),

  // Progreso de una importacion larga (copiar carpetas, descomprimir ZIP)
  onImportProgress: (callback) => {
    const listener = (_event, count) => callback(count);
    ipcRenderer.on('import:progress', listener);
    return () => ipcRenderer.removeListener('import:progress', listener);
  },

  // Cola de procesamiento
  getQueueSnapshot: () => ipcRenderer.invoke('queue:get-snapshot'),
  clearFinished: () => ipcRenderer.invoke('queue:clear-finished'),
  moveJob: (jobId, targetId, placeAfter) => ipcRenderer.invoke('queue:move-job', jobId, targetId, !!placeAfter),
  pauseQueue: () => ipcRenderer.invoke('queue:pause'),
  resumeQueue: () => ipcRenderer.invoke('queue:resume'),
  cancelPending: () => ipcRenderer.invoke('queue:cancel-pending'),
  onQueueUpdate: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('queue:update', listener);
    return () => ipcRenderer.removeListener('queue:update', listener);
  },
  // Aviso de "lote terminado" (texto ya redactado por el proceso principal)
  onBatchFinished: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('queue:batch-finished', listener);
    return () => ipcRenderer.removeListener('queue:batch-finished', listener);
  },

  // Configuracion persistente
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getLanguage: () => ipcRenderer.invoke('language:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),
  createProfile: (name, overrides) => ipcRenderer.invoke('profiles:create', name, overrides),
  renameProfile: (id, name) => ipcRenderer.invoke('profiles:rename', id, name),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  switchProfile: (id) => ipcRenderer.invoke('profiles:switch', id),

  // Carpeta de salida y avisos del entorno
  openOutputFolder: () => ipcRenderer.invoke('output:open'),
  getPreview: (jobId) => ipcRenderer.invoke('preview:get', jobId),
  getPreviewDetail: (jobId, request) => ipcRenderer.invoke('preview:detail', jobId, request),
  getOutputInfo: () => ipcRenderer.invoke('output:get'),
  chooseOutputDir: () => ipcRenderer.invoke('output:choose'),
  resetOutputDir: () => ipcRenderer.invoke('output:reset'),
  checkCloudSync: () => ipcRenderer.invoke('app:cloud-sync-check'),
  dismissCloudWarning: () => ipcRenderer.invoke('app:dismiss-cloud-warning'),

  // Necesario para leer la ruta real de un archivo soltado (drag & drop) en el renderer
  // `webUtils` existe desde Electron 29; el instalador de Mac usa Electron 26 (el ultimo que arranca en macOS 10.13 y
  // 10.14), donde la ruta del archivo soltado se lee de `file.path`. Una sola interfaz para los dos.
  getPathForFile: (file) => (webUtils && typeof webUtils.getPathForFile === 'function' ? webUtils.getPathForFile(file) : file.path),

  // Errores inesperados del proceso principal, para no fallar nunca en silencio
  onAppError: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('app:error', listener);
    return () => ipcRenderer.removeListener('app:error', listener);
  }
});
