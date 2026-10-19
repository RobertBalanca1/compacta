'use strict';

const { t } = require('../shared/i18n');

// IMPORTANTE: esto debe ir antes de requerir cualquier cosa que pueda tocar
// el threadpool de libuv (sharp incluido), por eso system-info se importa
// solo (sin arrastrar sharp) y esta linea va lo primero de todo el archivo.
const { getDefaultConcurrency } = require('./system-info');
// Cada foto en proceso ocupa un hilo de este grupo durante todo su codificado;
// ademas se reparte entre las copias de archivo, renombrados y lecturas de
// carpeta de la importacion. Con holgura de +4 sobre los trabajos en
// paralelo, importar un ZIP o una carpeta enorme MIENTRAS se comprime no
// se queda esperando turno detras de las fotos.
process.env.UV_THREADPOOL_SIZE = String(Math.max(8, getDefaultConcurrency() + 4));

const { app, BrowserWindow } = require('electron');
const { APP_USER_MODEL_ID } = require('./app-id');

// Windows identifica y agrupa las notificaciones (y el anclaje de la barra
// de tareas) por este id -- debe ser el mismo "appId" con el que se empaqueta
// la app. Sin esto, Windows no relaciona el proceso en ejecucion con el
// acceso directo instalado y usa la identidad interna de Electron en su
// lugar: de ahi que cada notificacion mostrara "electron.app.Compacta" como
// cabecera (en vez de "Compacta") con un icono generico en vez del de la
// app. Ver app-id.js sobre por que este valor esta escrito aqui a mano en
// vez de leerse de package.json.
app.setAppUserModelId(APP_USER_MODEL_ID);
const path = require('path');
const fs = require('fs');
const { ensureBaseFolders, getInputDir, getOutputDir } = require('./paths');
const { applyOutputDirAtStartup } = require('./output-dir');
const { sharedIndex } = require('./duplicates');
const { warmSharp } = require('./sharp-lazy');
const { applyLanguage } = require('./language');
const { refreshAppMenu } = require('./app-menu');
const { registerSchemeAsPrivileged, registerProtocolHandler } = require('./protocol');
const { setupIpcHandlers } = require('./ipc-handlers');
const { listBatches, findUnprocessedFiles, cleanupOrphanedTempFiles, getOutputPathFor } = require('./file-manager');
const queueManager = require('./queue-manager');
const manifestStore = require('./manifest-store');
const { killAllChildren } = require('./processor/child-processes');
const { removeExtractionLeftovers } = require('./system-archive');

// Debe registrarse antes de que la app este lista.
registerSchemeAsPrivileged();

let mainWindow = null;

/**
 * Red de seguridad final: nada de lo que pase en el proceso principal debe
 * cerrar la app en silencio ni dejar a la persona sin saber que algo fallo.
 * Cada operacion de archivo/cola ya tiene su propio try/catch especifico;
 * esto solo cubre lo verdaderamente inesperado.
 */
function notifyRendererOfError(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:error', message);
  }
}

/**
 * Igual, pero para avisos de ARRANQUE: la ventana se acaba de crear y su pagina
 * aun no cargo, asi que un mensaje enviado ya se perderia sin que nadie lo vea.
 */
function notifyRendererWhenReady(message) {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!contents) return;
  if (contents.isLoading()) contents.once('did-finish-load', () => notifyRendererOfError(message));
  else notifyRendererOfError(message);
}

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  notifyRendererOfError(t('app.unexpected'));
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  notifyRendererOfError(t('app.unexpectedFile'));
});

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#1c1a17',
    // Oculta hasta tener el primer dibujo listo (sin parpadeo blanco). Antes
    // faltaba esto y el manejador de 'ready-to-show' no hacia nada, porque la
    // ventana ya estaba visible desde el principio.
    show: false,
    // macOS: sin barra de titulo, con los tres botones (cerrar/minimizar/ampliar) sobre la propia ventana. La
    // interfaz les deja sitio (ver `html[data-platform='mac'] .topbar` en styles.css); `y` los centra en esa barra.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 25 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  // En pantalla completa los tres botones desaparecen y el hueco que se les dejo sobraria.
  for (const [event, on] of [['enter-full-screen', true], ['leave-full-screen', false]]) {
    win.on(event, () => {
      if (!win.isDestroyed()) win.webContents.send('window:fullscreen', on);
    });
  }

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // sharp se carga ahora (ventana ya dibujada) y no antes: ver sharp-lazy.js.
  win.webContents.once('did-finish-load', () => setTimeout(warmSharp, 50));
  win.once('ready-to-show', () => win.show());
  // Si por lo que sea 'ready-to-show' no llegara nunca, la ventana no debe
  // quedarse invisible para siempre.
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, 4000);

  // `npm run dev` (y el README lo prometia) abre las herramientas de
  // desarrollador. Antes nada leia ese parametro.
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });

  if (process.env.COMPACTA_DEBUG) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log('[DEBUG-renderer]', level, message, `${sourceId}:${line}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error('[DEBUG-renderer-crash]', details);
    });
    win.webContents.on('did-fail-load', (_e, code, description) => {
      console.error('[DEBUG-did-fail-load]', code, description);
    });
    win.webContents.on('dom-ready', () => console.log('[DEBUG] dom-ready'));
    win.webContents.on('did-finish-load', async () => {
      console.log('[DEBUG] did-finish-load');
      if (process.env.COMPACTA_SCREENSHOT) {
        await new Promise((r) => setTimeout(r, 400));
        const image = await win.webContents.capturePage();
        fs.writeFileSync(process.env.COMPACTA_SCREENSHOT, image.toPNG());
        console.log('[DEBUG] screenshot saved');
      }
    });
  }
}

/**
 * Solo una copia de Compacta a la vez. Si se abrieran dos (doble clic dos
 * veces, o abrirla desde el Dock mientras aun corre), las dos procesarian
 * las mismas carpetas al mismo tiempo, se pisarian los archivos de salida y
 * el registro de fotos ya hechas. La segunda simplemente trae la primera al
 * frente.
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (app.isReady()) {
      createMainWindow();
    }
  });

  // macOS: cerrar la ventana no cierra la app; el icono del Dock debe poder
  // abrir una nueva. Se registra ANTES de cualquier await de arranque.
  app.on('activate', () => {
    if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  app.whenReady().then(async () => {
    // La ventana se crea LO PRIMERO: antes se esperaba a validar la carpeta de salida (una prueba de
    // escritura que, con un disco de red o externo lento, podia tardar muchos segundos con la app sin
    // ventana). Ahora se valida a la vez; quien necesite saber la carpeta definitiva espera a esa
    // validacion (`describeOutputDirWhenReady`, `applyConfiguredOutputDir`).
    applyLanguage(); // antes que nada: los avisos que salgan ya van en el idioma de la persona
    refreshAppMenu(); // macOS: menu propio y en ese mismo idioma (en Windows/Linux no hace nada)
    const outputReady = applyOutputDirAtStartup();
    fs.mkdirSync(getInputDir(), { recursive: true });
    registerProtocolHandler();
    setupIpcHandlers(() => mainWindow);
    createMainWindow();

    const outputState = await outputReady;
    ensureBaseFolders();
    if (outputState.fellBackFrom) {
      notifyRendererWhenReady(t('app.outputUnavailable', { dir: outputState.fellBackFrom }));
    }

    // Limpieza de arranque: temporales huerfanos de un cierre anterior, y
    // reanudacion de cualquier imagen que se quedo pendiente sin procesar.
    try {
      await cleanupOrphanedTempFiles(getInputDir());
      await cleanupOrphanedTempFiles(getOutputDir());
      await removeExtractionLeftovers(path.join(getInputDir(), '.extract')); // descompresiones que quedaron a medias
      const batches = await listBatches();
      // El indice de duplicados se construye AHORA, con la lista que ya se tiene (un solo recorrido de
      // input/ en el arranque): asi la primera vez que se suelte algo ya esta listo.
      sharedIndex(getInputDir(), () => batches.flatMap((batch) => batch.files));
      const pendingFiles = await findUnprocessedFiles(batches);
      if (pendingFiles.length > 0) {
        queueManager.addJobs(pendingFiles.map((inputPath) => ({ inputPath, outputPath: getOutputPathFor(inputPath) })));
      }
    } catch (err) {
      console.error('[arranque] no se pudo reanudar el trabajo pendiente:', err);
      notifyRendererWhenReady(t('app.pendingCheckFailed'));
    }
  });
}

// Deja escrito en disco el registro de "ya procesado" antes de salir.
app.on('will-quit', () => {
  killAllChildren(); // un video o una descompresion a medias no deben seguir con la app cerrada
  manifestStore.flush();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
