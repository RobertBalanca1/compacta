'use strict';

/**
 * Utilidades de escritura de salida que comparten TODOS los compresores
 * (imagenes y videos): escritura atomica, informe del resultado y eleccion
 * del nombre final cuando dos archivos de la misma carpeta se llaman igual
 * y solo cambia la extension. Viven aqui, y no dentro de un compresor
 * concreto, para que cada uno tenga una sola responsabilidad y ninguno
 * dependa del otro.
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { isSupportedMedia, foldName } = require('./formats');

/** Cambia la extension de una ruta (foto.jpg + '.webp' -> foto.webp). */
function withExtension(filePath, ext) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  return path.join(dir, base + ext);
}

function buildReport(inputPath, outputPath, originalBytes, newBytes, skipped, reason) {
  const savedBytes = Math.max(0, originalBytes - newBytes);
  const savedPercent = originalBytes > 0
    ? Math.round((savedBytes / originalBytes) * 1000) / 10
    : 0;
  return { input: inputPath, output: outputPath, originalBytes, newBytes, savedBytes, savedPercent, skipped, reason };
}

/**
 * En Windows, un antivirus, el indexador de busqueda u OneDrive suelen tener
 * el archivo "agarrado" unos milisegundos justo despues de crearlo, y el
 * renombrado falla con EPERM/EBUSY/EACCES aunque nada este mal. Un par de
 * reintentos cortos lo resuelven; sin ellos, ese error pasajero aparecia al
 * usuario como una foto fallida ("revisa que no este abierta en otro
 * programa") cuando bastaba con esperar un instante.
 */
async function renameWithRetry(from, to) {
  const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
  const delaysMs = [80, 200, 500, 1000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      if (!RETRYABLE.has(err.code) || attempt >= delaysMs.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}

/**
 * Nombre del temporal junto al destino final. El formato (".tmp-" + 12
 * hexadecimales) es el que reconoce cleanupOrphanedTempFiles() para borrar
 * restos de una escritura interrumpida: no cambiarlo sin cambiar tambien eso.
 */
function tempPathFor(finalPath) {
  return `${finalPath}.tmp-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Escribe de forma atomica: primero a un archivo temporal junto al destino
 * final, y solo si termina bien lo renombra al nombre definitivo. Si el
 * proceso se interrumpe a mitad (crash, corte de luz, cierre forzado), el
 * peor caso es un archivo ".tmp-xxxx" huerfano, NUNCA un archivo de salida
 * corrupto o a medias con el nombre final. Esos temporales huerfanos, si
 * llegaran a quedar, se limpian solos en el siguiente arranque.
 */
async function atomicWrite(finalPath, writeFn) {
  const tmpPath = tempPathFor(finalPath);
  try {
    await writeFn(tmpPath);
    await renameWithRetry(tmpPath, finalPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Copia el original tal cual a la salida (de forma atomica). */
function copyOriginal(inputPath, outputPath) {
  return atomicWrite(outputPath, (tmp) => fs.copyFile(inputPath, tmp));
}

/**
 * Si en la misma carpeta hay otro archivo con el mismo nombre y OTRA extension
 * (foto.jpg + foto.png, o clip.mov + clip.mp4), los dos acabarian guardados
 * como el mismo archivo de salida -- por ejemplo ambas como foto.webp con
 * "Convertir a WebP", o ambos videos como clip.mp4 -- y el segundo
 * sobrescribiria al primero sin avisar (se perdia uno). En ese caso cada uno
 * lleva su extension original en el nombre: foto_jpg.jpg y foto_png.png. El
 * resultado es siempre el mismo para el mismo archivo, asi que reprocesar no
 * crea copias.
 */
async function chooseOutputPath(inputPath, requestedOutputPath) {
  const ownName = path.basename(inputPath);
  const ownExt = path.extname(ownName);
  const stem = path.basename(ownName, ownExt);
  const index = await getSiblingIndex(path.dirname(inputPath));
  if (!index) return requestedOutputPath;
  const sameStem = index.get(foldName(stem)) || [];
  const clash = sameStem.some((name) => name !== ownName && path.extname(name).toLowerCase() !== ownExt.toLowerCase());
  if (!clash) return requestedOutputPath;
  return path.join(path.dirname(requestedOutputPath), `${stem}_${ownExt.slice(1).toLowerCase()}${ownExt}`);
}

/**
 * Indice "nombre sin extension (minuscula) -> archivos con ese nombre" de una
 * carpeta, para detectar choques. Se lee la carpeta una vez y se reutiliza
 * mientras no cambie (antes se leia entera para cada foto: con 5000 fotos en
 * una carpeta eran 25 millones de comparaciones). Se valida con un simple
 * stat de la carpeta, cuya fecha de modificacion cambia en cuanto se anade o
 * quita un archivo, asi que nunca se usa un listado desactualizado.
 */
const SIBLING_CACHE_MAX_DIRS = 64;
const siblingCache = new Map(); // dir -> { mtimeMs, index }

/**
 * Carpetas que se estan COPIANDO ahora mismo (ver importer.js): se sabe de antemano todos los nombres
 * que van a tener, asi que el indice de hermanos es exacto desde el primer momento y no hay que
 * esperar a que termine la copia para empezar a comprimir ni releer la carpeta (cuyo contenido
 * cambia con cada archivo copiado) por cada foto. dir -> indice.
 */
const expectedSiblings = new Map(); // dir -> { index, uses }: `uses` = importaciones que copian a la vez en esa carpeta

function addToIndex(index, name) {
  if (!isSupportedMedia(name)) return;
  const key = foldName(path.basename(name, path.extname(name)));
  const list = index.get(key);
  if (list) list.push(name);
  else index.set(key, [name]);
}

/** Declara los nombres que va a tener `dir` cuando termine de copiarse. */
function expectSiblings(dir, names) {
  // Dos importaciones pueden copiar a la vez a la MISMA carpeta (se unen las carpetas con el mismo nombre):
  // los nombres se suman y la carpeta solo se da por terminada cuando acaban las dos.
  const entry = expectedSiblings.get(dir) || { index: new Map(), uses: 0 };
  for (const name of names) addToIndex(entry.index, name);
  entry.uses += 1;
  expectedSiblings.set(dir, entry);
}

/** Un archivo copiado con un nombre distinto del previsto (otro lo ocupo mientras tanto). */
function addSibling(dir, name) {
  const entry = expectedSiblings.get(dir);
  if (entry) addToIndex(entry.index, name);
}

/** Un archivo previsto que ya no va a llegar (era un duplicado y se descarto). */
function unexpectSibling(dir, name) {
  const entry = expectedSiblings.get(dir);
  if (!entry) return;
  const index = entry.index;
  const key = foldName(path.basename(name, path.extname(name)));
  const list = index.get(key);
  if (!list) return;
  const left = list.filter((n) => n !== name);
  if (left.length > 0) index.set(key, left);
  else index.delete(key);
}

/** La copia de `dir` termino: desde ahora manda lo que hay en disco. */
function releaseSiblings(dir) {
  const entry = expectedSiblings.get(dir);
  if (entry && --entry.uses > 0) return; // aun hay otra importacion copiando a esta carpeta
  expectedSiblings.delete(dir);
  siblingCache.delete(dir);
}

async function getSiblingIndex(dir) {
  if (expectedSiblings.has(dir)) return expectedSiblings.get(dir).index;
  let mtimeMs;
  try {
    mtimeMs = (await fs.stat(dir)).mtimeMs;
  } catch {
    return null;
  }
  const cached = siblingCache.get(dir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.index;

  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const index = new Map();
  for (const name of names) addToIndex(index, name);
  if (siblingCache.size >= SIBLING_CACHE_MAX_DIRS) siblingCache.delete(siblingCache.keys().next().value);
  siblingCache.set(dir, { mtimeMs, index });
  return index;
}

module.exports = {
  withExtension,
  buildReport,
  renameWithRetry,
  tempPathFor,
  atomicWrite,
  copyOriginal,
  chooseOutputPath,
  expectSiblings,
  addSibling,
  unexpectSibling,
  releaseSiblings
};
