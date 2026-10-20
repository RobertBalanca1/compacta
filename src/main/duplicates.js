'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { walkMedia } = require('./media-walker');
const { isSupportedVideo, isSidecarOf } = require('./processor/formats');

/**
 * Detecta fotos y videos IDENTICOS (byte a byte) a algo ya importado.
 *
 * QUE CUENTA COMO DUPLICADO (y que no):
 *  - Solo el contenido EXACTAMENTE igual. Dos fotos parecidas pero distintas (la
 *    misma escena con la boca abierta y con la boca cerrada, una rafaga, la misma
 *    foto guardada con otra calidad o recortada) NO son duplicadas: tienen bytes
 *    distintos, asi que nunca se omiten. No se usa ninguna comparacion "por
 *    parecido" a proposito: omitiria fotos que la persona quiere conservar.
 *  - Es duplicado si es identico a (a) algo que llego antes en ESTA misma importacion
 *    (se comprime una sola vez) o (b) algo importado antes cuyo resultado SIGUE
 *    existiendo: esta en la cola o ya esta en la carpeta de salida (`isLive`).
 *  - Lo importado en otra ocasion y cuyo resultado ya no existe (se borro la salida,
 *    se cambio de carpeta de salida, dio error...) NO cuenta. Antes se comparaba con
 *    TODO lo que alguna vez entro en input/ (esa carpeta no se vacia nunca), asi que
 *    cualquier foto que se hubiera soltado alguna vez, aunque fuera en una prueba de
 *    hace semanas, se omitia: "omitir duplicados omite todo".
 *
 * Para no leer enteros videos de varios GB sin necesidad, se
 * descarta por etapas, de la mas barata a la mas cara:
 *   1. el tamano (un stat; casi todo se descarta aqui),
 *   2. una huella del principio y del final (2 lecturas cortas),
 *   3. el hash completo (solo si todo lo anterior coincide).
 * Dos archivos distintos con el mismo tamano pasan por (1) y se separan en (2)
 * o (3); nunca se confunden.
 *
 * INDICE COMPARTIDO (1.1.0). El detector necesita saber el tamano de todo lo que hay en
 * input/, y esa carpeta no se vacia nunca. Recorrerla y hacer un `stat` de cada archivo ANTES de
 * copiar el primero era lo que hacia que la app se quedara "pensando" al soltar algo, y cada
 * vez mas con el uso (medido: 22 ms con historial vacio, 360 ms con 20.000 archivos en un disco
 * rapidisimo; en Windows con antivirus, segundos). Ahora el indice se construye UNA vez (la app
 * lo empieza al arrancar, ver `sharedIndex`) y las importaciones lo reutilizan y lo van
 * ampliando. Un archivo que ya no existe se descarta del indice al tocarlo, sin fallar.
 */

const STAT_CONCURRENCY = 16;
const EDGE_BYTES = 1024 * 1024;

function hashStream(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fsSync.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Huella del principio y el final: separa casi todos los archivos del mismo tamano sin leerlos enteros. */
async function edgeFingerprint(filePath, size) {
  const handle = await fs.open(filePath, 'r');
  try {
    const hash = crypto.createHash('sha256');
    const head = Buffer.alloc(Math.min(EDGE_BYTES, size));
    await handle.read(head, 0, head.length, 0);
    hash.update(head);
    if (size > EDGE_BYTES) {
      const tail = Buffer.alloc(Math.min(EDGE_BYTES, size - EDGE_BYTES));
      await handle.read(tail, 0, tail.length, size - tail.length);
      hash.update(tail);
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function mapLimited(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  }));
}

/**
 * Indice "tamano -> rutas conocidas" de lo que hay en input/. `listFiles` devuelve las rutas
 * (por defecto, recorre `inputDir`). Nunca falla: lo que desaparezca a mitad simplemente no cuenta.
 */
async function buildIndex(listFiles) {
  const bySize = new Map();
  const register = (filePath, size) => {
    if (!bySize.has(size)) bySize.set(size, []);
    bySize.get(size).push(filePath);
  };
  const existing = await listFiles();
  await mapLimited(existing, STAT_CONCURRENCY, async (filePath) => {
    try {
      register(filePath, (await fs.stat(filePath)).size);
    } catch {
      // desaparecio mientras tanto: no cuenta
    }
  });
  return { bySize, register };
}

// inputDir -> Promise del indice compartido de la app (ver el comentario de la cabecera).
const sharedIndexes = new Map();

/**
 * Indice compartido de `inputDir`: se construye la primera vez que se pide y despues se reutiliza.
 * `listFiles` solo se usa en esa primera vez (el arranque pasa la lista que ya habia sacado).
 */
function sharedIndex(inputDir, listFiles = () => walkMedia(inputDir)) {
  if (!sharedIndexes.has(inputDir)) sharedIndexes.set(inputDir, buildIndex(listFiles));
  return sharedIndexes.get(inputDir);
}

/**
 * Apunta archivos que se importaron SIN pasar por el detector (el ajuste esta apagado, o es "Procesar
 * de todos modos"): si el indice ya existe, que los conozca para la proxima vez. Si aun no se
 * construyo, no hace falta: cuando se construya los encontrara en disco.
 */
async function noteImported(inputDir, files) {
  const pending = sharedIndexes.get(inputDir);
  if (!pending || files.length === 0) return;
  const index = await pending;
  await mapLimited(files, STAT_CONCURRENCY, async (filePath) => {
    try {
      index.register(filePath, (await fs.stat(filePath)).size);
    } catch {
      // desaparecio: no cuenta
    }
  });
}

/** Solo para pruebas: olvida los indices compartidos. */
function resetSharedIndexes() {
  sharedIndexes.clear();
}

/** Huellas por archivo (borde y completa), calculadas una sola vez y recordadas durante la importacion. */
function makeFingerprints() {
  const edgeCache = new Map();
  const fullCache = new Map();
  return {
    async edge(filePath, size) {
      if (!edgeCache.has(filePath)) edgeCache.set(filePath, edgeFingerprint(filePath, size));
      return edgeCache.get(filePath);
    },
    async full(filePath) {
      if (!fullCache.has(filePath)) fullCache.set(filePath, hashStream(filePath));
      return fullCache.get(filePath);
    },
    drop(filePath) {
      edgeCache.delete(filePath);
      fullCache.delete(filePath);
    }
  };
}

/**
 * Compara `filePath` con un `candidate` del mismo tamano: 'igual', 'distinto' o 'desaparecido' (el candidato ya no esta:
 * se borro la salida, se elimino de la cola...; no cuenta). Si el que falla es el archivo NUEVO, el error sube y se trata
 * como unico. `mine.full` guarda el hash completo del archivo nuevo para no recalcularlo con cada candidato.
 */
async function compareWith(candidate, filePath, size, myEdge, mine, { edge, full }) {
  try {
    if ((await edge(candidate, size)) !== myEdge) return 'distinto';
    mine.full = mine.full || await full(filePath);
    return (await full(candidate)) === mine.full ? 'igual' : 'distinto';
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') && candidate !== filePath) return 'desaparecido';
    throw err;
  }
}

/**
 * Crea un detector sobre lo que hay AHORA en `inputDir`. Hay que crearlo ANTES
 * de copiar nada de la importacion actual, para que lo nuevo no se compare
 * consigo mismo. Con `index` (el compartido) no recorre el disco: reutiliza lo ya sabido.
 */
async function createDuplicateDetector(inputDir, { isLive = async () => true, index = null } = {}) {
  const { bySize, register } = index || await buildIndex(() => walkMedia(inputDir));
  const arrivedNow = new Set(); // las que llegaron en ESTA importacion
  const { edge, full, drop } = makeFingerprints();

  const forget = (filePath, size) => {
    const list = bySize.get(size);
    if (list) bySize.set(size, list.filter((candidate) => candidate !== filePath));
    drop(filePath);
  };

  /**
   * ¿Es `filePath` identico a alguno de los ya conocidos? Devuelve 'importacion' (identico a algo
   * de esta misma importacion), 'anterior' (identico a algo anterior cuyo resultado sigue
   * existiendo) o null (unico, o identico solo a algo cuyo resultado ya no existe).
   */
  async function classify(filePath, size) {
    const candidates = bySize.get(size);
    if (!candidates || candidates.length === 0) return null;
    const myEdge = await edge(filePath, size);
    const mine = { full: null }; // el hash completo del archivo nuevo: se calcula solo si hace falta, y una vez
    let found = null;
    // Los candidatos que ya no existen se quitan del indice AL FINAL (no se copia la lista en cada
    // archivo: con miles de copias del mismo tamano eso seria cuadratico).
    const gone = [];
    try {
      for (const candidate of candidates) {
        const verdict = await compareWith(candidate, filePath, size, myEdge, mine, { edge, full });
        if (verdict === 'desaparecido') {
          gone.push(candidate);
          continue;
        }
        if (verdict === 'distinto') continue;
        if (arrivedNow.has(candidate)) return 'importacion';
        if (!found && await isLive(candidate)) found = 'anterior';
      }
    } finally {
      for (const candidate of gone) forget(candidate, size);
    }
    return found;
  }

  // Si comparar falla por lo que sea (un archivo que desaparecio, uno agarrado por el antivirus...), ese archivo
  // cuenta como UNICO: la deteccion de duplicados es un extra y NUNCA debe tumbar la importacion entera
  // (antes un solo fallo aqui dejaba todo sin hacer).
  async function classifySafely(filePath, size) {
    try {
      return await classify(filePath, size);
    } catch {
      return null;
    }
  }

  return {
    /**
     * Separa los archivos recien importados en unicos y duplicados ({ filePath, kind }).
     * Los unicos pasan a contar como "ya conocidos" para lo que venga despues.
     */
    async filter(files) {
      const unique = [];
      const duplicates = [];
      for (const filePath of files) {
        let size;
        try {
          size = (await fs.stat(filePath)).size;
        } catch {
          unique.push(filePath);
          continue;
        }
        const kind = size > 0 ? await classifySafely(filePath, size) : null; // un archivo vacio no es "igual" a otro vacio en ningun sentido util
        if (kind) {
          duplicates.push({ filePath, kind });
        } else {
          unique.push(filePath);
          if (size > 0) {
            register(filePath, size);
            arrivedNow.add(filePath);
          }
        }
      }
      return { unique, duplicates };
    }
  };
}

/**
 * Borra la copia duplicada que ya se habia hecho en input/, sus subtitulos si
 * ya no acompanan a ningun otro video de su carpeta, y las carpetas que
 * hayan quedado vacias (sin pasar de `stopDir`).
 */
async function discardDuplicate(filePath, stopDir) {
  const dir = path.dirname(filePath);
  await fs.unlink(filePath).catch(() => {});
  if (isSupportedVideo(filePath)) {
    const names = await fs.readdir(dir).catch(() => []);
    const remainingVideos = names.filter((name) => isSupportedVideo(name));
    for (const name of names) {
      if (!isSidecarOf(name, filePath)) continue;
      if (remainingVideos.some((video) => isSidecarOf(name, video))) continue;
      await fs.unlink(path.join(dir, name)).catch(() => {});
    }
  }
  let current = dir;
  while (current.startsWith(stopDir) && current !== stopDir) {
    try {
      await fs.rmdir(current); // solo borra si esta vacia
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

module.exports = { createDuplicateDetector, discardDuplicate, sharedIndex, noteImported, resetSharedIndexes };
