'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { getManifestFilePath, getInputDir } = require('./paths');

/**
 * Registro de "esto ya se proceso", independiente de mirar el contenido de
 * output/. Es un respaldo para el caso en que la carpeta de salida (dentro
 * de Documentos) no refleje fielmente lo que ya se hizo -- el caso mas
 * probable es sincronizacion en la nube (OneDrive/iCloud) que no ha
 * terminado de bajar o mostrar los archivos localmente en el momento exacto
 * en que la app arranca y escanea output/.
 *
 * No reemplaza la comprobacion de output/ (ver file-manager.js): se usan
 * las dos en conjunto. Si CUALQUIERA de las dos dice "ya esta hecho", se
 * confia en eso y no se reprocesa.
 */

/**
 * Manifiesto en memoria, cargado una sola vez por proceso. Antes,
 * markDone/isMarkedDone volvian a leer y volver a parsear el archivo entero
 * de disco EN CADA FOTO procesada (ver _worker en queue-manager.js): con
 * lotes de decenas o cientos de fotos, eso son decenas o cientos de lecturas
 * sincronas y bloqueantes del mismo archivo -- cada vez un poco mas grande,
 * porque el manifiesto solo crece -- contribuyendo al lag reportado en lotes
 * grandes. Ahora se lee una vez y se guarda en memoria; cada escritura
 * (markDone/forget) sigue yendo a disco de inmediato, igual que antes, para
 * no perder la garantia de que sobrevive a cerrar la app a medio lote.
 */
let cache = null;

function loadManifest() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(getManifestFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function keyFor(inputPath) {
  // Relativa a input/, no absoluta: asi el registro sigue siendo valido
  // aunque cambie la carpeta base (por ejemplo, un usuario nuevo en la
  // misma PC, con "Documentos" en otra ruta).
  return path.relative(getInputDir(), inputPath).split(path.sep).join('/');
}

/**
 * Escritura a disco con "debounce". Antes se reescribia el manifiesto ENTERO
 * de forma sincrona (bloqueando el proceso principal) tras CADA foto: con N
 * fotos, N escrituras de un archivo que solo crece, o sea O(N^2) bytes y un
 * tiron del proceso principal por foto. Ahora los cambios se juntan y se
 * escribe una vez cada ~400 ms, de forma asincrona y atomica (temporal +
 * renombrar). La durabilidad sigue garantizada:
 *  - flush() escribe ya, de forma sincrona. Se llama cuando la cola se
 *    vacia o se detiene, y automaticamente al salir del proceso.
 *  - Si aun asi la app muriera de golpe (corte de luz), lo unico que podria
 *    faltar son las marcas de los ultimos ~400 ms, y esas fotos se
 *    reconocen igualmente por existir ya en output/ (ver file-manager.js).
 */
const WRITE_DELAY_MS = 400;
let dirty = false;
let timer = null;
let writeInFlight = false;

function serialize() {
  return JSON.stringify(cache || {});
}

function writeSync() {
  const file = getManifestFilePath();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, serialize(), 'utf-8');
  fs.renameSync(tmp, file);
}

async function writeAsync() {
  if (writeInFlight) return; // la escritura en curso volvera a mirar `dirty` al acabar
  writeInFlight = true;
  try {
    while (dirty) {
      dirty = false;
      const file = getManifestFilePath();
      const tmp = `${file}.tmp-${process.pid}`;
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(tmp, serialize(), 'utf-8');
        await fsp.rename(tmp, file);
      } catch {
        // No es fatal: si no se puede escribir el manifiesto, la deteccion
        // por archivo de salida en output/ sigue funcionando como antes.
        await fsp.unlink(tmp).catch(() => {});
        return;
      }
    }
  } finally {
    writeInFlight = false;
  }
}

function persist() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    writeAsync();
  }, WRITE_DELAY_MS);
  // Que un temporizador pendiente nunca impida cerrar el proceso.
  if (typeof timer.unref === 'function') timer.unref();
}

/** Escribe ya, sincronamente, lo que haya pendiente. Seguro de llamar cuantas veces haga falta. */
function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!dirty) return;
  dirty = false;
  try {
    writeSync();
  } catch {
    // ver comentario en writeAsync
  }
}

process.on('exit', flush);

/** Marca una foto como terminada. Se llama al completar cada trabajo con exito. */
function markDone(inputPath) {
  const manifest = loadManifest();
  manifest[keyFor(inputPath)] = { done: true, at: Date.now() };
  persist();
}

/** ¿Esta foto ya quedo marcada como procesada anteriormente? */
function isMarkedDone(inputPath) {
  const manifest = loadManifest();
  const entry = manifest[keyFor(inputPath)];
  return !!(entry && entry.done);
}

/** Se llama al eliminar un pendiente (por si acaso quedo alguna marca residual). */
function forget(inputPath) {
  const manifest = loadManifest();
  const key = keyFor(inputPath);
  if (key in manifest) {
    delete manifest[key];
    persist();
  }
}

module.exports = { markDone, isMarkedDone, forget, flush };
