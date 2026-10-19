'use strict';

const fs = require('fs/promises');
const path = require('path');
const { getInputDir, getOutputDir } = require('./paths');
const { isJunkFile, candidateOutputFileNames, foldName } = require('./processor/formats');
const { walkMedia } = require('./media-walker');
const manifestStore = require('./manifest-store');

/**
 * Lo que hay en input/ y en output/: que lotes existen, a que salida
 * corresponde cada archivo, que falta por procesar y limpieza de restos. (La
 * entrada de archivos nuevos esta en importer.js.)
 */

/** Lista los lotes (subcarpetas de primer nivel) presentes hoy en input/. */
async function listBatches() {
  const inputDir = getInputDir();
  await fs.mkdir(inputDir, { recursive: true });
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && !isJunkFile(e.name));
  const scanned = await Promise.all(dirs.map(async (entry) => {
    const batchPath = path.join(inputDir, entry.name);
    return { name: entry.name, path: batchPath, files: await walkMedia(batchPath) };
  }));
  return scanned.filter((b) => b.files.length > 0);
}

/** Traduce una ruta dentro de input/ a su equivalente en output/, misma estructura. */
function getOutputPathFor(inputFilePath) {
  const relative = path.relative(getInputDir(), inputFilePath);
  return path.join(getOutputDir(), relative);
}

/**
 * Compara cada archivo de input/ contra output/ y devuelve solo las que aun
 * no tienen una salida ya generada. Esto hace que, si la app se cierra a
 * mitad de un lote grande (o el usuario simplemente vuelve a abrirla
 * despues), el trabajo pendiente se retome solo sin repetir lo que ya
 * estaba terminado.
 *
 * Una foto cuenta como "ya hecha" si se cumple CUALQUIERA de estas dos:
 *  1. El registro interno (manifest-store.js) la tiene marcada. Es exacto
 *     (usa la ruta completa con extension) y no depende de que output/ este
 *     disponible en ese instante, asi que es la fuente principal.
 *  2. En su carpeta de output/ existe un archivo con uno de los nombres con
 *     los que el compresor puede haberla guardado (ver
 *     candidateOutputFileNames en formats.js). Este respaldo cubre fotos
 *     procesadas por versiones anteriores, que aun no escribian el registro.
 *
 * Historial: la version original comparaba `output/foto.JPG` contra
 * `input/foto.JPG` letra por letra, pero el compresor normaliza la extension
 * (.JPG -> .jpg, o .webp con "Convertir a WebP"), asi que casi nunca
 * coincidia y todo se recomprimia en cada apertura. Una correccion
 * intermedia comparaba solo el nombre sin extension, lo cual daba falsos
 * "ya hecho" (foto.png se daba por terminada si existia foto.jpg). Ahora se
 * compara contra la lista exacta de nombres posibles.
 */
async function findUnprocessedFiles(batches) {
  const pending = [];
  const namesByDir = new Map(); // outputDir -> Set de nombres de archivo en minuscula

  async function existingFileNames(outputDir) {
    if (namesByDir.has(outputDir)) return namesByDir.get(outputDir);
    let entries;
    try {
      entries = await fs.readdir(outputDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => foldName(e.name)));
    namesByDir.set(outputDir, names);
    return names;
  }

  for (const batch of batches) {
    for (const inputPath of batch.files) {
      if (manifestStore.isMarkedDone(inputPath)) continue;

      const relative = path.relative(getInputDir(), inputPath);
      const relDir = path.dirname(relative);
      const outputDir = relDir === '.' ? getOutputDir() : path.join(getOutputDir(), relDir);

      const names = await existingFileNames(outputDir);
      const alreadyDone = candidateOutputFileNames(inputPath).some((name) => names.has(name));
      if (!alreadyDone) pending.push(inputPath);
    }
  }
  return pending;
}

/**
 * ¿Existe ya en output/ el resultado de este archivo de input/? Mismo criterio de nombres que
 * findUnprocessedFiles (el compresor puede cambiar la extension). Lo usa la deteccion de
 * duplicados: algo identico solo cuenta como "ya hecho" si su resultado sigue ahi.
 */
async function hasOutputFor(inputFilePath, dirCache) {
  const outputDir = path.dirname(getOutputPathFor(inputFilePath));
  let names = dirCache ? dirCache.get(outputDir) : undefined;
  if (!names) {
    let entries;
    try {
      entries = await fs.readdir(outputDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    names = new Set(entries.filter((e) => e.isFile()).map((e) => foldName(e.name)));
    // Con `dirCache`, cada carpeta de salida se lista UNA vez por importacion: comprobar miles de
    // archivos de la misma carpeta releia su listado entero cada vez (cuadratico, y la ventana se
    // quedaba como colgada al volver a soltar una carpeta grande).
    if (dirCache) dirCache.set(outputDir, names);
  }
  return candidateOutputFileNames(inputFilePath).some((name) => names.has(name));
}

/**
 * Borra archivos temporales huerfanos (".tmp-xxxxxx") que hayan podido
 * quedar de una escritura interrumpida (cierre forzado, corte de luz) en un
 * arranque anterior. Solo toca temporales con mas de un minuto de
 * antiguedad, para no interferir con una escritura en curso de otra
 * instancia si por algun motivo hubiera dos abiertas a la vez.
 */
async function cleanupOrphanedTempFiles(dir) {
  const ONE_MINUTE = 60 * 1000;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await cleanupOrphanedTempFiles(fullPath);
    } else if (entry.isFile() && /\.tmp-[0-9a-f]{12}$/.test(entry.name)) {
      const stat = await fs.stat(fullPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > ONE_MINUTE) {
        await fs.unlink(fullPath).catch(() => {});
      }
    }
  }
}

module.exports = {
  listBatches,
  getOutputPathFor,
  findUnprocessedFiles,
  hasOutputFor,
  cleanupOrphanedTempFiles
};
