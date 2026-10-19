'use strict';

const { t } = require('../shared/i18n');

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { getInputDir, getOutputDir, getDefaultOutputDir, setOutputDirOverride } = require('./paths');
const { loadSettings, setOutputDir } = require('./settings-store');

/**
 * Carpeta de salida elegible. Lo delicado esta aqui y no repartido por la app:
 *  - SE VALIDA antes de aceptarla (no puede estar dentro de input/ ni contenerla,
 *    ni ser la raiz de un disco, y se comprueba que se pueda escribir).
 *  - Si la elegida deja de estar disponible (disco externo desenchufado, carpeta
 *    borrada o sin permisos), se usa la de siempre y se AVISA, en vez de dejar
 *    que cada foto falle por separado.
 *  - Cambiarla NO repite trabajo: el registro de "ya procesado" es por archivo de
 *    entrada (manifest-store.js), no depende de donde este la salida.
 */

// En Windows y macOS las rutas no distinguen mayusculas; en Linux si.
const fold = (p) => (process.platform === 'linux' ? p : p.toLowerCase());

function isInside(child, parent) {
  const rel = path.relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function validateOutputDir(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    return { ok: false, reason: t('output.invalidPath') };
  }
  const dir = path.resolve(candidate);
  if (dir === path.parse(dir).root) {
    return { ok: false, reason: t('output.notWholeDisk') };
  }
  const input = getInputDir();
  if (isInside(dir, input)) {
    return { ok: false, reason: t('output.insideInput') };
  }
  if (isInside(input, dir)) {
    return { ok: false, reason: t('output.containsInput') };
  }
  try {
    const stat = await fs.stat(dir).catch(() => null);
    if (stat && !stat.isDirectory()) return { ok: false, reason: t('output.notFolder') };
    await fs.mkdir(dir, { recursive: true });
    // La unica prueba fiable de que se puede escribir es escribir.
    const probe = path.join(dir, `.compacta-prueba-${crypto.randomBytes(6).toString('hex')}`);
    await fs.writeFile(probe, '');
    await fs.unlink(probe);
  } catch {
    return { ok: false, reason: t('output.cannotWrite') };
  }
  return { ok: true, dir };
}

/** Estado actual, para mostrarlo en pantalla. */
function describeOutputDir() {
  const dir = getOutputDir();
  return { dir, defaultDir: getDefaultOutputDir(), isDefault: dir === getDefaultOutputDir() };
}

// Cuando se comprobo por ultima vez, de verdad (con prueba de escritura), la carpeta elegida. Entre
// una importacion y la siguiente basta con comprobar que sigue ahi: la prueba de escritura crea y
// borra un archivo, y con un disco de red o una carpeta de nube eso se nota (y se hacia ANTES de copiar
// el primer archivo de cada importacion).
const REVALIDATE_AFTER_MS = 30 * 1000;
let lastValidated = null; // { dir, at }

async function stillUsable(dir) {
  if (!lastValidated || lastValidated.dir !== dir || Date.now() - lastValidated.at > REVALIDATE_AFTER_MS) return false;
  const stat = await fs.stat(dir).catch(() => null);
  return !!stat && stat.isDirectory();
}

/**
 * Aplica lo guardado en ajustes. Se llama al arrancar y antes de cada
 * importacion (barato): asi un disco desenchufado se detecta en el momento.
 * Devuelve { ...estado, fellBackFrom } donde fellBackFrom es la carpeta elegida
 * que no se pudo usar (o null).
 */
async function applyConfiguredOutputDir() {
  const wanted = loadSettings().outputDir;
  if (!wanted) {
    setOutputDirOverride(null);
    return { ...describeOutputDir(), fellBackFrom: null };
  }
  const dir = path.resolve(wanted);
  if (await stillUsable(dir)) {
    setOutputDirOverride(dir);
    return { ...describeOutputDir(), fellBackFrom: null };
  }
  const check = await validateOutputDir(wanted);
  if (check.ok) {
    lastValidated = { dir: check.dir, at: Date.now() };
    setOutputDirOverride(check.dir);
    return { ...describeOutputDir(), fellBackFrom: null };
  }
  lastValidated = null;
  setOutputDirOverride(null);
  return { ...describeOutputDir(), fellBackFrom: wanted };
}

// La validacion del arranque (ver index.js): la ventana ya esta abierta mientras se hace.
let startupApply = null;

function applyOutputDirAtStartup() {
  startupApply = applyConfiguredOutputDir();
  return startupApply;
}

/** Estado de la carpeta de salida, esperando a que termine la validacion del arranque si sigue en curso. */
async function describeOutputDirWhenReady() {
  if (startupApply) await startupApply.catch(() => {});
  return describeOutputDir();
}

/** Valida, guarda y aplica una carpeta nueva. */
async function chooseOutputDir(candidate) {
  const check = await validateOutputDir(candidate);
  if (!check.ok) return { ok: false, reason: check.reason };
  setOutputDir(check.dir);
  setOutputDirOverride(check.dir);
  lastValidated = { dir: check.dir, at: Date.now() };
  return { ok: true, ...describeOutputDir() };
}

/** Vuelve a la carpeta de siempre. */
function resetOutputDir() {
  setOutputDir(null);
  setOutputDirOverride(null);
  return { ok: true, ...describeOutputDir() };
}

module.exports = { validateOutputDir, describeOutputDirWhenReady, applyConfiguredOutputDir, applyOutputDirAtStartup, chooseOutputDir, resetOutputDir };
