'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { getInputDir } = require('./paths');
const { isSupportedMedia, isSupportedVideo, isSubtitleFile, isSidecarOf, sidecarSuffix, isArchiveFile, archiveStem, isJunkFile } = require('./processor/formats');
const { extractArchive } = require('./archive-extractor');
const { createContext, recordSkipped } = require('./import-context');
const { walkGroups } = require('./media-walker');
const { loadSettings } = require('./settings-store');
const { createDuplicateDetector, discardDuplicate, sharedIndex, noteImported } = require('./duplicates');
const { expectSiblings, addSibling, unexpectSibling, releaseSiblings } = require('./processor/output-files');

/**
 * Importacion: lleva lo que la persona arrastra o elige (archivos sueltos,
 * varias carpetas, comprimidos) a la carpeta interna input/, conservando la estructura.
 */

function timestampSlug() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// Cuantas copias de archivo a la vez al importar. Copiar es E/S de disco, no
// CPU: varias a la vez aprovechan mejor discos SSD y carpetas de red sin
// llegar a saturar nada. Acotado a proposito (nunca "todo de golpe").
const COPY_CONCURRENCY = 8;

// Lo copiado se entrega a la cola por TANDAS, sin esperar a que termine la carpeta entera (antes una
// carpeta de 1.000 fotos no empezaba a comprimirse hasta tenerlas todas copiadas). La primera tanda es
// corta para que se vea trabajar enseguida; despues van de 64 en 64 (comprobar duplicados y encolar
// cuesta algo por tanda, no por archivo).
const DELIVER_FIRST = 8;
const DELIVER_CHUNK = 64;

/**
 * Ejecuta `fn` sobre cada elemento con como mucho `limit` a la vez. Si alguno
 * falla NO se detiene el resto: `fn` es responsable de capturar sus errores.
 */
async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

/**
 * Crea (y reserva) una carpeta con nombre unico: Fotos, Fotos (2), Fotos (3)...
 * Se reserva con mkdir SIN recursive: si dos importaciones a la vez eligen el
 * mismo nombre, solo una lo consigue y la otra pasa al siguiente. Antes se
 * comprobaba con existsSync y se creaba despues, dejando un hueco entre las
 * dos operaciones por el que dos lotes podian mezclarse.
 */
async function reserveUniqueDir(baseDir, desiredName) {
  await fs.mkdir(baseDir, { recursive: true });
  for (let counter = 1; ; counter += 1) {
    const name = counter === 1 ? desiredName : `${desiredName} (${counter})`;
    const candidate = path.join(baseDir, name);
    try {
      await fs.mkdir(candidate);
      return candidate;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

/**
 * La carpeta de `name` dentro de `baseDir`, creandola si no existe. Si YA existe (se importo antes una carpeta con
 * ese nombre), se reutiliza: lo nuevo se une a ella en vez de crear "Fotos (2)", "Fotos (3)"... que llenaban
 * input/ y output/ de carpetas con numero al volver a soltar la misma carpeta. Devuelve si la creo esta vez
 * (`created`): una carpeta ajena nunca se debe borrar (ver importArchive).
 */
async function ensureDir(baseDir, name) {
  await fs.mkdir(baseDir, { recursive: true });
  const candidate = path.join(baseDir, name);
  try {
    await fs.mkdir(candidate);
    return { dir: candidate, created: true };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const stat = await fs.stat(candidate).catch(() => null);
  if (stat && stat.isDirectory()) return { dir: candidate, created: false };
  return { dir: await reserveUniqueDir(baseDir, name), created: true }; // habia un ARCHIVO con ese nombre
}

/** foto.jpg -> foto (2).jpg -> foto (3).jpg ... */
function numberedName(name, n) {
  const ext = path.extname(name);
  return `${path.basename(name, ext)} (${n})${ext}`;
}

/**
 * Al unirse a una carpeta que ya tiene cosas, un archivo cuyo nombre ya esta ocupado (otra foto distinta que se
 * llama igual, o la misma importada otra vez) recibe "foto (2).jpg": nunca se pisa nada. Los subtitulos de un
 * video renombrado siguen su nuevo nombre. Devuelve lo que ya habia en la carpeta (para los nombres previstos).
 */
async function resolveNameConflicts(group) {
  let existing;
  try {
    existing = await fs.readdir(group.destDir);
  } catch {
    return [];
  }
  if (existing.length === 0) return [];
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  for (const entry of group.files) {
    const original = path.basename(entry.dest);
    if (taken.has(original.toLowerCase())) {
      let n = 2;
      while (taken.has(numberedName(original, n).toLowerCase())) n += 1;
      entry.dest = path.join(path.dirname(entry.dest), numberedName(original, n));
      if (isSupportedVideo(entry.src)) {
        const stem = path.basename(entry.dest, path.extname(entry.dest));
        for (const sidecar of group.sidecars || []) {
          const subtitleName = path.basename(sidecar.src);
          if (isSidecarOf(subtitleName, entry.src)) sidecar.dest = path.join(group.destDir, stem + sidecarSuffix(subtitleName, entry.src));
        }
      }
    }
    taken.add(path.basename(entry.dest).toLowerCase());
  }
  return existing;
}

/** Copia un archivo; si el sistema de ficheros lo permite, lo "clona" sin duplicar datos. Nunca sobrescribe. */
function copyOne(src, dest) {
  return fs.copyFile(src, dest, fsSync.constants.COPYFILE_FICLONE | fsSync.constants.COPYFILE_EXCL);
}

/**
 * Copia sin pisar nada: si en el ultimo momento otra importacion ocupo ese nombre (dos copias a la vez a la misma
 * carpeta), usa el siguiente libre. Devuelve la ruta con la que quedo.
 */
async function copyUnique(src, dest) {
  let target = dest;
  for (let n = 2; n < 10000; n += 1) {
    try {
      await copyOne(src, target);
      return target;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      target = path.join(path.dirname(dest), numberedName(path.basename(dest), n));
    }
  }
  throw new Error('no free name');
}

/** Acumula una lista grande sin `push(...lista)`, que revienta la pila con ~100k elementos. */
function pushAll(target, items) {
  for (const item of items) target.push(item);
}

/**
 * Copia un grupo de archivos y descomprime sus comprimidos, entregando lo importado (rutas finales
 * dentro de input/) a `deliver` por tandas, EN ORDEN, mientras se sigue copiando. Un archivo que no se
 * pueda copiar (bloqueado, sin permisos) se cuenta aparte y NO detiene al resto.
 *
 * Por que es seguro empezar a comprimir antes de terminar la copia: el compresor mira los demas
 * archivos de la carpeta para que `foto.jpg` y `foto.png` no se pisen. Como aqui se conocen de
 * antemano TODOS los nombres que tendra la carpeta (`expectSiblings`), esa decision es exacta desde el
 * primer momento. Los subtitulos se copian ANTES que los videos para que ya esten cuando se comprima el
 * video (los copia el compresor a la salida).
 */
async function importGroup(group, ctx, deliver) {
  if (group.files.length > 0) {
    await fs.mkdir(group.destDir, { recursive: true });
    const alreadyThere = await resolveNameConflicts(group);

    await mapLimit(group.sidecars || [], COPY_CONCURRENCY, async ({ src, dest }) => {
      try {
        await copyOne(src, dest);
      } catch (err) {
        if (err.code !== 'EEXIST') ctx.failedCount += 1; // ya estaba: es el mismo subtitulo de antes
      }
    });

    expectSiblings(group.destDir, [...alreadyThere, ...group.files.map(({ dest }) => path.basename(dest))]);
    const total = group.files.length;
    const copied = new Array(total).fill(undefined); // undefined = pendiente, null = no se pudo copiar
    let settledPrefix = 0; // todo lo anterior a este indice ya termino (bien o mal)
    let delivered = 0;
    let chunkSize = DELIVER_FIRST;
    let chain = Promise.resolve();
    let deliverError = null;

    const handOver = (end) => {
      const batch = copied.slice(delivered, end).filter(Boolean);
      delivered = end;
      chunkSize = DELIVER_CHUNK;
      if (batch.length === 0) return;
      // Una a una y en orden; un fallo se guarda y se lanza al final (no queda una promesa sin atender).
      chain = chain.then(() => deliver(batch)).catch((err) => {
        deliverError = deliverError || err;
      });
    };

    try {
      await mapLimit(group.files, COPY_CONCURRENCY, async ({ src, dest }, index) => {
        try {
          const finalPath = await copyUnique(src, dest);
          if (finalPath !== dest) addSibling(group.destDir, path.basename(finalPath));
          copied[index] = finalPath;
          ctx.sourceOf.set(finalPath, src);
        } catch {
          ctx.failedCount += 1;
          copied[index] = null;
        }
        while (settledPrefix < total && copied[settledPrefix] !== undefined) settledPrefix += 1;
        // Si de golpe hay varias tandas listas (el primer archivo era el ultimo en terminar), se entregan de a
        // `chunkSize`: asi la primera es SIEMPRE corta, no solo cuando el orden de llegada acompana.
        while (settledPrefix - delivered >= chunkSize) handOver(delivered + chunkSize);
      });
      while (delivered < total) handOver(Math.min(total, delivered + chunkSize));
      await chain;
    } finally {
      releaseSiblings(group.destDir);
    }
    if (deliverError) throw deliverError;
  }

  for (const archivePath of group.archives) {
    await deliver(await importArchive(archivePath, group.destDir, ctx));
  }
}

/**
 * Descomprime un comprimido en una subcarpeta de `parentDir` (nombre = el del archivo; si ya existe, se une a
 * ella, ver ensureDir). Los extractores ya dan "foto (2).jpg" a lo que se repite, asi que no pisan nada.
 */
async function importArchive(archivePath, parentDir, ctx) {
  const { dir: destDir, created } = await ensureDir(parentDir, archiveStem(archivePath));
  const extracted = await extractArchive(archivePath, destDir, ctx);
  // Un comprimido sin ninguna foto ni video no debe dejar una carpeta vacia dando vueltas. SOLO si la creo
  // esta vez: si ya existia, tiene cosas de antes que no son suyas.
  if (extracted.length === 0 && created) await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
  return extracted;
}

/**
 * Subtitulos de los videos que llegaron SUELTOS. Se buscan en la carpeta de
 * origen de cada video (arrastrar solo `Peli.mkv` trae tambien su `Peli.srt`)
 * y entre los subtitulos arrastrados a la vez. El destino lleva el nombre que
 * recibio el video en el lote (puede haberse renombrado por una colision).
 * Los subtitulos sueltos que no acompanan a ningun video se cuentan como no
 * compatibles.
 */
async function findLooseSidecars(files, droppedSubtitles, destDir, ctx) {
  const listings = new Map();
  const listing = async (dir) => {
    if (!listings.has(dir)) listings.set(dir, await fs.readdir(dir).catch(() => []));
    return listings.get(dir);
  };
  const sidecars = [];
  const claimed = new Set();
  for (const { src, dest } of files) {
    if (!isSupportedVideo(src)) continue;
    const destStem = path.basename(dest, path.extname(dest));
    const dir = path.dirname(src);
    const candidates = (await listing(dir)).map((name) => path.join(dir, name));
    for (const subtitle of droppedSubtitles) if (!candidates.includes(subtitle)) candidates.push(subtitle);
    for (const candidate of candidates) {
      if (!isSidecarOf(path.basename(candidate), src)) continue;
      claimed.add(path.resolve(candidate));
      sidecars.push({ src: candidate, dest: path.join(destDir, destStem + sidecarSuffix(path.basename(candidate), src)) });
    }
  }
  for (const subtitle of droppedSubtitles) if (!claimed.has(path.resolve(subtitle))) recordSkipped(ctx, subtitle);
  return sidecars;
}

/**
 * Lo que se hace con cada tanda de archivos ya copiados: quitar los duplicados (si hay detector), apuntar lo
 * importado y entregarlo a la cola (`onFiles`). Sin detector, lo importado se apunta igualmente en el
 * indice compartido, para la proxima vez que se active.
 */
function makeDeliver({ detector, ctx, inputDir, importedFiles, notes, onFiles }) {
  return async function deliver(incoming) {
    let files = incoming;
    if (detector && files.length > 0) {
      const { unique, duplicates } = await detector.filter(files);
      for (const { filePath, kind } of duplicates) {
        try {
          await discardDuplicate(filePath, inputDir);
        } catch {
          // quedarse con una copia de mas en input/ no es grave; dejar de importar si
        }
        unexpectSibling(path.dirname(filePath), path.basename(filePath));
        const origin = ctx.sourceOf.get(filePath);
        if (origin && ctx.duplicateSources.length < 20000) ctx.duplicateSources.push(origin);
        ctx.duplicateCount += 1;
        if (kind === 'importacion') ctx.duplicateInDrop += 1;
        else ctx.duplicateBefore += 1;
      }
      files = unique;
    }
    if (files.length === 0) return;
    pushAll(importedFiles, files);
    if (!detector) notes.push(noteImported(inputDir, files).catch(() => {}));
    if (onFiles) await onFiles(files);
  };
}

/**
 * Importa rutas arrastradas o elegidas (archivos sueltos, VARIAS carpetas y/o
 * comprimidos de cualquier formato) dentro de la carpeta input, preservando la estructura de
 * carpetas. Los archivos sueltos se agrupan en un unico lote nuevo; cada comprimido
 * se descomprime en su propia carpeta; los que haya dentro de una carpeta
 * tambien se descomprimen.
 *
 * `onFiles(rutas)` (opcional) se llama por TANDAS mientras se copia (ver DELIVER_FIRST y
 * DELIVER_CHUNK), para empezar a comprimir ya sin esperar a que termine la importacion entera ni
 * siquiera la carpeta en curso. Es seguro porque los nombres de la carpeta se conocen de antemano
 * (ver importGroup).
 *
 * Devuelve las rutas finales (ya dentro de input) y los avisos para la persona.
 * `duplicateSources`: archivos de origen de lo omitido por repetido (para "Procesar de todos modos").
 */
async function importPaths(droppedPaths, { onFiles, isLive, allowDuplicates = false, password = null } = {}) {
  const inputDir = getInputDir();
  await fs.mkdir(inputDir, { recursive: true });

  const importedFiles = [];
  const looseFiles = [];
  const looseSubtitles = [];
  const ctx = createContext();
  ctx.password = password; // para los ZIP cifrados (la acaba de escribir la persona; solo en memoria)
  // Carpeta de trabajo para los comprimidos que se abren con el tar del
  // sistema: dentro de input/ (mismo disco, mover es instantaneo) y con punto
  // delante, asi ningun recorrido la toma por una carpeta de fotos.
  ctx.tempRoot = path.join(inputDir, '.extract');

  // Se crea ANTES de copiar nada, para que lo que llega no se compare consigo mismo.
  // `allowDuplicates` ("Procesar de todos modos") lo desactiva SOLO para esta importacion.
  // Usa el indice COMPARTIDO de input/ (se construye una vez, ver duplicates.js): recorrer todo el
  // historial en cada importacion era lo que hacia que la app tardara en empezar.
  const detector = allowDuplicates || loadSettings().skipDuplicates === false
    ? null
    : await createDuplicateDetector(inputDir, { isLive, index: await sharedIndex(inputDir) });
  const notes = []; // sin detector, lo importado se apunta igualmente en el indice (para la proxima vez)

  const deliver = makeDeliver({ detector, ctx, inputDir, importedFiles, notes, onFiles });

  for (const srcPath of droppedPaths) {
    let stat;
    try {
      stat = await fs.stat(srcPath);
    } catch {
      ctx.failedCount += 1;
      continue;
    }

    if (stat.isDirectory()) {
      const { dir: destDir } = await ensureDir(inputDir, path.basename(srcPath));
      for await (const group of walkGroups(srcPath, destDir, ctx)) {
        await importGroup(group, ctx, deliver);
      }
    } else if (isJunkFile(srcPath)) {
      continue;
    } else if (isArchiveFile(srcPath)) {
      await deliver(await importArchive(srcPath, inputDir, ctx));
    } else if (isSupportedMedia(srcPath)) {
      looseFiles.push(srcPath);
    } else if (isSubtitleFile(srcPath)) {
      looseSubtitles.push(srcPath); // se decide al final si acompana a algun video
    } else {
      recordSkipped(ctx, srcPath);
    }
  }

  if (looseFiles.length > 0) {
    const destDir = await reserveUniqueDir(inputDir, `Lote_${timestampSlug()}`);
    // Dos archivos sueltos de carpetas distintas pueden llamarse igual
    // (IMG_001.jpg): el segundo pisaba al primero. Se les da un nombre unico.
    const used = new Set();
    const files = looseFiles.map((src) => {
      const ext = path.extname(src);
      const stem = path.basename(src, ext);
      let name = path.basename(src);
      for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${stem} (${n})${ext}`;
      used.add(name.toLowerCase());
      return { src, dest: path.join(destDir, name) };
    });
    const sidecars = await findLooseSidecars(files, looseSubtitles, destDir, ctx);
    await importGroup({ destDir, files, archives: [], sidecars }, ctx, deliver);
  } else {
    for (const subtitle of looseSubtitles) recordSkipped(ctx, subtitle);
  }

  await Promise.all(notes);

  return {
    importedFiles,
    skippedCount: ctx.skippedCount,
    skippedExtensions: [...ctx.skippedExtensions],
    failedCount: ctx.failedCount,
    duplicateCount: ctx.duplicateCount,
    duplicateInDrop: ctx.duplicateInDrop,
    duplicateBefore: ctx.duplicateBefore,
    duplicateSources: ctx.duplicateSources,
    archiveCount: ctx.archiveCount,
    failedArchives: ctx.failedArchives
  };
}

/**
 * Guarda una imagen pegada directamente desde el portapapeles (sin archivo
 * de origen en disco, por ejemplo una captura de pantalla) reutilizando la
 * misma logica de importPaths: se escribe a un archivo temporal y se deja
 * que el camino ya probado (loose file -> lote "Lote_<fecha>") haga el resto.
 */
async function importClipboardImage(buffer, extension, options) {
  // La extension viene del renderer: solo se acepta algo con forma de
  // extension (punto + hasta 5 letras/numeros). Cualquier otra cosa (por
  // ejemplo "./../algo") se descarta, porque se concatena a un nombre de
  // archivo y podria escapar de la carpeta temporal.
  const safeExt = typeof extension === 'string' && /^\.[a-z0-9]{1,5}$/i.test(extension) ? extension : '.png';
  const tempPath = path.join(os.tmpdir(), `compacta-pegado-${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`);
  await fs.writeFile(tempPath, buffer);
  try {
    return await importPaths([tempPath], options);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

module.exports = { importPaths, importClipboardImage };
