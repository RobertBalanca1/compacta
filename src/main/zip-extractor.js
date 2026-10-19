'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const yauzl = require('yauzl');
const { isSupportedMedia, isSubtitleFile, isArchiveFile, archiveStem } = require('./processor/formats');
const { pruneOrphanSidecars } = require('./import-sidecars');
const { ArchiveError, describeArchiveError } = require('./archive-errors');
const { safeSegments, uniqueFilePath } = require('./file-names');
const { createContext, recordSkipped } = require('./import-context');
const { atomicWrite } = require('./processor/output-files');
const { decryptEntry } = require('./zip-decrypt');

/**
 * Descompresion de .zip hecha a prueba de archivos hostiles o rotos.
 *
 * Decisiones de diseno (cada una existe por un motivo concreto):
 *  - STREAMING con yauzl (lectura perezosa, entrada a entrada): un ZIP de
 *    varios GB no se carga en memoria; solo hay un archivo abierto a la vez.
 *  - Solo se extraen imagenes y videos compatibles (y ZIPs anidados). Nada mas se
 *    escribe en disco: ni .exe, ni scripts, ni basura de macOS (__MACOSX,
 *    ._foto.jpg, .DS_Store, Thumbs.db).
 *  - Anti "zip-slip": el nombre de cada entrada se parte en segmentos, se
 *    limpia cada uno (sin "..", sin letras de unidad, sin caracteres que
 *    Windows no admite) y se reconstruye SIEMPRE por debajo de la carpeta
 *    destino. Una entrada llamada "../../Windows/x.jpg" no puede escapar.
 *  - Anti "zip-bomb": limites de numero de entradas, de tamano por archivo y
 *    de tamano total descomprimido; ademas yauzl valida que los bytes
 *    reales coincidan con el tamano declarado (validateEntrySizes).
 *  - Escritura atomica (temporal + renombrar): si la app se cierra a mitad,
 *    nunca queda en input/ una foto a medias que luego se intentaria procesar.
 *  - Un ZIP malo NO aborta el resto: se anota en `failedArchives` con el motivo.
 */

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: false }, (err, zipFile) => {
      if (err) reject(err);
      else resolve(zipFile);
    });
  });
}

function openEntryStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (err, stream) => {
      if (err) reject(err);
      else resolve(stream);
    });
  });
}

/**
 * Los bytes CRUDOS de la entrada (sin descifrar ni descomprimir), leidos directamente del archivo desde su cabecera
 * local. yauzl no sirve aqui: no deja leer en crudo una entrada guardada sin comprimir ni una AES (metodo 99).
 */
async function openRawStream(zipPath, entry) {
  if (entry.compressedSize === 0) return Readable.from([]);
  const handle = await fsp.open(zipPath, 'r');
  try {
    const header = Buffer.alloc(30);
    const { bytesRead } = await handle.read(header, 0, 30, entry.relativeOffsetOfLocalHeader);
    if (bytesRead < 30 || header.readUInt32LE(0) !== 0x04034b50) throw new ArchiveError('corrupt', 'bad local header');
    // El nombre y los extras de la cabecera LOCAL pueden medir distinto que los del directorio central.
    const start = entry.relativeOffsetOfLocalHeader + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    return fs.createReadStream(zipPath, { start, end: start + entry.compressedSize - 1 });
  } finally {
    await handle.close();
  }
}

/**
 * Abre una entrada para leerla en claro. Las cifradas se descifran con la contrasena de la importacion
 * (ctx.password); sin ella, o con el cifrado «fuerte» de PKWARE (que no se soporta), se avisa. Solo se pide la
 * contrasena de lo que de verdad se va a importar: un leeme.txt cifrado no hace falta abrirlo.
 */
async function openStream(zipFile, zipPath, entry, ctx) {
  if (!entry.isEncrypted()) return openEntryStream(zipFile, entry);
  if (entry.generalPurposeBitFlag & 0x40) throw new ArchiveError('encrypted-unsupported', 'strong encryption');
  if (!ctx.password) throw new ArchiveError('encrypted', 'protegido con contraseña');
  return decryptEntry(await openRawStream(zipPath, entry), entry, ctx.password);
}

/** El aviso de un ZIP que no se pudo abrir; si es por la contrasena, lleva lo que hace falta para volver a intentarlo. */
function failureNotice(zipName, zipPath, depth, err) {
  const notice = { name: zipName, reason: describeArchiveError(err) };
  const locked = err instanceof ArchiveError && (err.code === 'encrypted' || err.code === 'wrong-password');
  // Solo un ZIP suelto (no uno anidado dentro de otro: su ruta es un temporal) se puede reintentar con contrasena.
  return locked && depth === 0 ? { ...notice, needsPassword: true, archivePath: zipPath, wrongPassword: err.code === 'wrong-password' } : notice;
}

/**
 * Extrae las imagenes de un ZIP dentro de `destDir`.
 * Devuelve la lista de rutas (ya escritas) de las imagenes extraidas.
 * Nunca lanza por un ZIP defectuoso: lo anota en ctx.failedArchives.
 */
async function extractZip(zipPath, destDir, ctx = createContext(), depth = 0) {
  const zipName = path.basename(zipPath);
  const extracted = [];
  const sidecars = []; // subtitulos en archivo aparte: se quedan solo los que tienen video
  let zipFile;

  try {
    zipFile = await openZip(zipPath);
  } catch (err) {
    ctx.failedArchives.push({ name: zipName, reason: describeArchiveError(err) });
    return extracted;
  }
  ctx.archiveCount += 1;

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        zipFile.close();
        reject(err);
      };

      zipFile.on('error', fail);
      zipFile.on('end', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      zipFile.on('entry', (entry) => {
        (async () => {
          ctx.entries += 1;
          if (ctx.entries > ctx.limits.maxEntries) {
            throw new ArchiveError('too-many-entries', 'demasiados archivos');
          }
          if (/\/$/.test(entry.fileName)) return; // carpeta: se crea al escribir sus archivos
          const segments = safeSegments(entry.fileName);
          if (!segments) return; // basura del sistema: se ignora sin avisar
          const leaf = segments[segments.length - 1];
          const isNestedArchive = isArchiveFile(leaf);

          const isSubtitle = isSubtitleFile(leaf);
          if (!isNestedArchive && !isSupportedMedia(leaf) && !isSubtitle) {
            recordSkipped(ctx, leaf);
            return;
          }
          if (entry.uncompressedSize > ctx.limits.maxEntryBytes
            || ctx.totalBytes + entry.uncompressedSize > ctx.limits.maxTotalBytes) {
            throw new ArchiveError('too-big', 'demasiado grande');
          }
          ctx.totalBytes += entry.uncompressedSize;

          const target = path.join(destDir, ...segments);
          // Defensa en profundidad: aunque safeSegments ya lo impide, se
          // comprueba que la ruta final siga dentro del destino.
          const rel = path.relative(destDir, target);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new ArchiveError('unsafe-path', `ruta insegura en el ZIP: ${entry.fileName}`);
          }

          const stream = await openStream(zipFile, zipPath, entry, ctx);

          if (isNestedArchive) {
            if (depth + 1 >= ctx.limits.maxDepth) {
              stream.resume();
              recordSkipped(ctx, leaf);
              return;
            }
            const tmpZip = path.join(os.tmpdir(), `compacta-nested-${crypto.randomBytes(8).toString('hex')}${path.extname(leaf)}`);
            try {
              await pipeline(stream, fs.createWriteStream(tmpZip));
              const nestedDir = path.join(path.dirname(target), archiveStem(leaf));
              // Se le pasa el nombre real (no el temporal) para los avisos de error.
              const nested = await extractNested(tmpZip, leaf, nestedDir, ctx, depth + 1);
              extracted.push(...nested);
            } finally {
              await fsp.unlink(tmpZip).catch(() => {});
            }
            return;
          }

          await fsp.mkdir(path.dirname(target), { recursive: true });
          const finalPath = await uniqueFilePath(target);
          // Escritura atomica compartida con los compresores (con reintentos si un
          // antivirus tiene el archivo agarrado justo al terminar de escribirlo).
          await atomicWrite(finalPath, (tmp) => pipeline(stream, fs.createWriteStream(tmp)));
          (isSubtitle ? sidecars : extracted).push(finalPath);
        })().then(() => {
          if (!settled) zipFile.readEntry();
        }, fail);
      });

      zipFile.readEntry();
    });
  } catch (err) {
    // Lo ya extraido de este ZIP se conserva: mejor importar la parte buena
    // que tirarlo todo. El motivo se avisa a la persona.
    ctx.failedArchives.push(failureNotice(zipName, zipPath, depth, err));
  }

  await pruneOrphanSidecars(sidecars, extracted, ctx);
  return extracted;
}

/** Igual que extractZip, pero los avisos de error usan el nombre original. */
async function extractNested(tmpPath, displayName, destDir, ctx, depth) {
  const before = ctx.failedArchives.length;
  // Un comprimido dentro de un ZIP puede ser de cualquier formato (rar, 7z...):
  // lo reparte el despachador, que se anota en ctx al empezar la importacion.
  const files = await (ctx.extractArchive || extractZip)(tmpPath, destDir, ctx, depth);
  for (let i = before; i < ctx.failedArchives.length; i += 1) {
    if (ctx.failedArchives[i].name === path.basename(tmpPath)) ctx.failedArchives[i].name = displayName;
  }
  return files;
}

module.exports = { extractZip };
