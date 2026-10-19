'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

/**
 * Toda la app gira en torno a dos carpetas visibles para el usuario:
 *   Documentos/Compacta/input   -> lotes de imagenes por procesar
 *   Documentos/Compacta/output  -> resultado, exactamente la misma estructura
 * Ademas guardamos configuracion pequeña (calidad, modo agresivo, etc.)
 * en la carpeta de datos de usuario de Electron (no visible, estandar del SO).
 *
 * Esta logica se mantiene deliberadamente independiente de si `electron`
 * esta realmente corriendo o no: cuando se importa este archivo con Node
 * normal (por ejemplo, desde la suite de pruebas con `node --test`),
 * `require('electron')` devuelve un string (la ruta al binario), no la API.
 * En ese caso usamos una carpeta temporal en vez de fallar, para que toda la
 * logica de negocio se pueda probar sin necesidad de arrancar Electron.
 */
const electron = require('electron');
const app = typeof electron === 'object' ? electron.app : null;

// Fuera de Electron (pruebas automatizadas), cada proceso obtiene su propia
// carpeta temporal unica generada una sola vez. Esto evita que ejecuciones
// de la suite de pruebas se pisen entre si o acumulen estado de una corrida
// a otra: cada `node --test` arranca completamente limpio.
const fallbackBaseDir = path.join(os.tmpdir(), `compacta-test-${crypto.randomUUID()}`);

function getBaseDir() {
  if (app) {
    return path.join(app.getPath('documents'), 'Compacta');
  }
  return process.env.COMPACTA_TEST_BASE_DIR || fallbackBaseDir;
}

function getInputDir() {
  return path.join(getBaseDir(), 'input');
}

// Carpeta de salida elegida por la persona (o null = la de siempre). La fija
// output-dir.js al arrancar y al cambiarla; paths.js no sabe de ajustes para no
// depender de settings-store (que a su vez usa paths.js).
let outputDirOverride = null;

function getDefaultOutputDir() {
  return path.join(getBaseDir(), 'output');
}

function getOutputDir() {
  return outputDirOverride || getDefaultOutputDir();
}

function setOutputDirOverride(dir) {
  outputDirOverride = dir ? path.resolve(dir) : null;
}

function getSettingsFilePath() {
  const userDataDir = app ? app.getPath('userData') : getBaseDir();
  return path.join(userDataDir, 'settings.json');
}

/**
 * Ruta del "manifiesto" de fotos ya procesadas (ver manifest-store.js).
 * Vive en la carpeta de datos de usuario del sistema operativo, NUNCA
 * dentro de Documentos: esa es la carpeta que en Windows y Mac suele estar
 * redirigida a OneDrive/iCloud Drive, y cuyo contenido puede no estar
 * disponible localmente en todo momento (archivos "bajo demanda"). Al vivir
 * en userData, el registro de "esto ya se hizo" no depende de que la nube
 * haya terminado de sincronizar `output/` a tiempo.
 */
function getManifestFilePath() {
  const userDataDir = app ? app.getPath('userData') : getBaseDir();
  return path.join(userDataDir, 'processed-manifest.json');
}

/**
 * Deteccion best-effort de si la carpeta base vive dentro de una carpeta
 * sincronizada a la nube (OneDrive en Windows, iCloud Drive en Mac). No es
 * infalible -- solo mira si la ruta contiene esas palabras clave -- pero
 * cubre los casos por defecto mas comunes: en Windows 11, OneDrive suele
 * redirigir "Documentos" a algo como
 * `C:\Users\Nombre\OneDrive\Documentos`; en Mac, con iCloud Drive
 * sincronizando Escritorio y Documentos, `~/Documents` termina siendo un
 * enlace hacia `~/Library/Mobile Documents/com~apple~CloudDocs/Documents`.
 * Se usa solo para avisar, nunca para cambiar de carpeta ni bloquear nada.
 */
function isBaseDirCloudSynced() {
  const dir = getBaseDir().toLowerCase();
  return dir.includes('onedrive') || dir.includes('icloud') || dir.includes('mobile documents');
}

function ensureBaseFolders() {
  for (const dir of [getBaseDir(), getInputDir(), getOutputDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  getBaseDir,
  getInputDir,
  getOutputDir,
  getDefaultOutputDir,
  setOutputDirOverride,
  getSettingsFilePath,
  getManifestFilePath,
  isBaseDirCloudSynced,
  ensureBaseFolders
};
