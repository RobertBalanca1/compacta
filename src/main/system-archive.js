'use strict';

const { t } = require('../shared/i18n');

const { spawn } = require('child_process');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { track } = require('./processor/child-processes');
const { isSupportedMedia, isSubtitleFile, isArchiveFile, archiveStem, isJunkFile } = require('./processor/formats');
const { pruneOrphanSidecars } = require('./import-sidecars');
const { ArchiveError, describeArchiveError } = require('./archive-errors');
const { uniqueFilePath } = require('./file-names');
const { recordSkipped } = require('./import-context');

/**
 * Descompresion de RAR, 7z, tar, tar.gz, tar.bz2, tar.xz, etc. con el
 * programa "tar" que YA trae el sistema operativo (Windows 10/11 y macOS lo
 * incluyen; es bsdtar/libarchive, que entiende todos esos formatos). Asi no
 * hay nada extra que instalar ni que empaquetar en la app.
 *
 * Como se mantiene seguro y limpio:
 *  - Se extrae a una carpeta TEMPORAL y de ahi se importa SOLO lo que es foto
 *    o video (o un comprimido anidado). Nada mas llega a input/: ni
 *    ejecutables, ni scripts, ni la basura del sistema.
 *  - bsdtar ya rechaza por defecto rutas con ".." y absolutas; ademas aqui se
 *    recorre la carpeta temporal SIN seguir enlaces simbolicos, asi que un
 *    comprimido no puede hacer que se lea un archivo ajeno.
 *  - Anti bomba de descompresion: mientras tar trabaja se vigila lo que ocupa
 *    la carpeta temporal y se corta el proceso si pasa del limite.
 *  - Con contrasena (RAR/7z cifrados) tar se niega y se avisa con claridad.
 *
 * Sistemas antiguos: el tar de macOS 10.15/11 y el de algunas versiones de
 * Windows 10 es una libarchive vieja que NO abre el formato RAR5 (el que crea
 * WinRAR hoy). Para eso hay un respaldo: si falla el tar y la persona tiene
 * 7-Zip instalado, se usa el. Y si nada puede abrirlo, el aviso dice la
 * causa real (RAR5) y que hacer, en vez de un generico "dañado".
 */

const SIZE_CHECK_INTERVAL_MS = 1500;
let cachedTar; // undefined = sin buscar todavia; null = no hay

/**
 * Ruta del tar que entiende estos formatos en este sistema, o null.
 * COMPACTA_TAR_PATH la fuerza (diagnostico y pruebas); no se guarda en cache.
 */
function findTarBinary() {
  if (process.env.COMPACTA_TAR_PATH) return process.env.COMPACTA_TAR_PATH;
  if (cachedTar !== undefined) return cachedTar;
  const candidates = [];
  if (process.platform === 'win32') {
    // La ruta completa a proposito: en el PATH puede haber otro "tar" (el de
    // Git para Windows, por ejemplo) que no abre rar, 7z ni zip.
    candidates.push(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/usr/bin/tar');
  } else {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) candidates.push(path.join(dir, 'bsdtar'));
    candidates.push('/usr/bin/tar');
  }
  cachedTar = candidates.find((candidate) => fsSync.existsSync(candidate)) || null;
  return cachedTar;
}

/**
 * 7-Zip instalado por la persona (respaldo para RAR5 en sistemas antiguos), o
 * null. Una app de escritorio de macOS arranca con un PATH minimo que NO
 * incluye Homebrew, por eso se miran tambien sus carpetas habituales.
 * COMPACTA_SEVENZIP_PATH lo fuerza; el valor "none" lo desactiva.
 */
function findSevenZip() {
  const forced = process.env.COMPACTA_SEVENZIP_PATH;
  if (forced !== undefined) return forced === '' || forced === 'none' ? null : forced;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  let names;
  if (process.platform === 'win32') {
    names = ['7z.exe'];
    dirs.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip'), path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', '7-Zip'));
  } else {
    names = ['7zz', '7z'];
    dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fsSync.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** ¿Empieza como un RAR5 (el formato nuevo de WinRAR)? Solo lee 8 bytes. */
async function isRar5(archivePath) {
  let handle;
  try {
    handle = await fs.open(archivePath, 'r');
    const head = Buffer.alloc(8);
    await handle.read(head, 0, 8, 0);
    return head.equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]));
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/** Bytes que ocupa una carpeta (sin seguir enlaces simbolicos). */
async function directorySize(root) {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) total += (await fs.stat(full).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
}

/**
 * Ejecuta un extractor (tar o 7-Zip) y devuelve { code, output, exceededLimit }.
 * `output` es lo ultimo que escribio, para explicar el error si falla.
 */
function runExtractor(binary, args, outDir, byteLimit) {
  return new Promise((resolve, reject) => {
    const child = track(spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    let output = '';
    let exceededLimit = false;
    let checking = false;
    const collect = (chunk) => { output = (output + chunk).slice(-2000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      if ((await directorySize(outDir)) > byteLimit) {
        exceededLimit = true;
        child.kill();
      }
      checking = false;
    }, SIZE_CHECK_INTERVAL_MS);

    child.on('error', (err) => {
      clearInterval(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(timer);
      resolve({ code, output, exceededLimit });
    });
  });
}

/** Mueve un archivo; si origen y destino estan en discos distintos, lo copia. */
async function moveFile(from, to) {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.copyFile(from, to);
    await fs.unlink(from);
  }
}

/**
 * Recorre lo extraido en la carpeta temporal y deja en `destDir` solo fotos y
 * videos, respetando subcarpetas. Los comprimidos anidados se abren.
 */
async function collectMedia(tmpDir, destDir, ctx, depth) {
  const imported = [];
  const sidecars = []; // subtitulos en archivo aparte: se quedan solo los que tienen video
  const extractNested = ctx.extractArchive || extractWithSystemTar;
  const pending = [{ dir: tmpDir, rel: [] }];

  while (pending.length > 0) {
    const { dir, rel } = pending.pop();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (isJunkFile(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push({ dir: full, rel: [...rel, entry.name] });
        continue;
      }
      if (!entry.isFile()) continue; // enlaces simbolicos y especiales: nunca

      ctx.entries += 1;
      if (ctx.entries > ctx.limits.maxEntries) throw new ArchiveError('too-many-entries', 'demasiados archivos');

      if (isArchiveFile(entry.name)) {
        if (depth + 1 >= ctx.limits.maxDepth) {
          recordSkipped(ctx, entry.name);
          continue;
        }
        const nestedDir = path.join(destDir, ...rel, archiveStem(entry.name));
        imported.push(...await extractNested(full, nestedDir, ctx, depth + 1));
        continue;
      }
      const isSubtitle = isSubtitleFile(entry.name);
      if (!isSupportedMedia(entry.name) && !isSubtitle) {
        recordSkipped(ctx, entry.name);
        continue;
      }

      const { size } = await fs.stat(full);
      if (size > ctx.limits.maxEntryBytes || ctx.totalBytes + size > ctx.limits.maxTotalBytes) {
        throw new ArchiveError('too-big', 'demasiado grande');
      }
      ctx.totalBytes += size;

      const target = path.join(destDir, ...rel, entry.name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const finalPath = await uniqueFilePath(target);
      await moveFile(full, finalPath);
      (isSubtitle ? sidecars : imported).push(finalPath);
    }
  }
  await pruneOrphanSidecars(sidecars, imported, ctx);
  return imported;
}

// Frases CONCRETAS de "esto tiene contrasena" (tar y 7-Zip). No vale buscar
// solo "encrypt": 7-Zip imprime siempre una linea "Encrypted = -" que significa
// justo lo contrario, y cualquier fallo se habria etiquetado como contrasena.
const PASSWORD_PATTERN = /wrong password|incorrect password|enter password|passphrase|encrypted archive|header is encrypted|encryption is not supported/i;

/** tar primero (viene con el sistema); 7-Zip si el tar no pudo y la persona lo tiene. */
async function runExtractionAttempts(archivePath, tmpDir, byteLimit) {
  const tarPath = findTarBinary();
  const sevenZip = findSevenZip();
  if (!tarPath && !sevenZip) return { missing: true };

  let result = null;
  if (tarPath) {
    result = await runExtractor(tarPath, ['-xf', archivePath, '-C', tmpDir], tmpDir, byteLimit);
    if (result.code === 0 || result.exceededLimit || PASSWORD_PATTERN.test(result.output)) return result;
  }
  if (sevenZip) {
    // Lo que el tar dejara a medias se descarta antes de reintentar.
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });
    // Una clave de relleno evita que 7-Zip se quede esperando una contrasena
    // por teclado (no hay terminal): en un archivo cifrado da "Wrong password".
    const seven = await runExtractor(sevenZip, ['x', '-y', '-bd', '-pcompacta-sin-clave', `-o${tmpDir}`, '--', archivePath], tmpDir, byteLimit);
    // Codigos de 7-Zip: 0 = bien, 1 = avisos no graves (se acepta).
    if (seven.code === 0 || seven.code === 1) return { ...seven, code: 0 };
    return seven;
  }
  return result;
}

/**
 * Extrae las fotos y videos de un comprimido (cualquier formato que entienda
 * el tar del sistema, o 7-Zip) dentro de `destDir`. Devuelve las rutas
 * escritas. Nunca lanza por un comprimido defectuoso: lo anota en
 * ctx.failedArchives.
 */
async function extractWithSystemTar(archivePath, destDir, ctx, depth = 0) {
  const name = path.basename(archivePath);
  let failed = false;
  const fail = (reason) => {
    if (failed) return; // un solo aviso por comprimido, aunque falle en dos fases
    failed = true;
    ctx.failedArchives.push({ name, reason });
  };

  const tempRoot = ctx.tempRoot || path.join(os.tmpdir(), 'compacta-extract');
  await fs.mkdir(tempRoot, { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(tempRoot, 'x-'));

  try {
    const remaining = Math.max(0, ctx.limits.maxTotalBytes - ctx.totalBytes);
    const result = await runExtractionAttempts(archivePath, tmpDir, remaining);
    if (result.missing) {
      fail(t('archive.noTar'));
      return [];
    }
    if (result.exceededLimit) {
      fail(t('archive.tooBig'));
      return [];
    }
    if (result.code !== 0) {
      // 7-Zip empieza siempre con una linea de copyright: el motivo es la
      // linea de error, y si no hay ninguna reconocible, la ultima.
      const lines = result.output.split('\n').map((l) => l.trim()).filter(Boolean);
      // Se prefiere la frase que explica el problema a la que solo dice "ERROR: <ruta>".
      const explains = /can not open|cannot open|unsupported method|data error|crc failed|headers error|unexpected end|bsdtar:|tar:/i;
      const firstLine = lines.find((l) => explains.test(l)) || lines.find((l) => /^ERROR/i.test(l)) || lines[lines.length - 1] || 'no se pudo leer';
      // La contrasena se mira en TODA la salida, no solo en la linea elegida
      // (en 7-Zip, la frase util va una linea despues de la que dice "ERROR").
      if (PASSWORD_PATTERN.test(result.output)) {
        fail(t('archive.encrypted'));
      } else if (await isRar5(archivePath)) {
        fail(t('archive.rar5'));
      } else {
        fail(describeArchiveError(new Error(firstLine)));
      }
      // Lo que si se alcanzo a extraer se conserva (igual que con un ZIP a medias).
    } else {
      ctx.archiveCount += 1;
    }
    return await collectMedia(tmpDir, destDir, ctx, depth);
  } catch (err) {
    fail(describeArchiveError(err));
    return [];
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Borra restos de extracciones que quedaron a medias (cierre forzado, corte de luz). */
function removeExtractionLeftovers(tempRoot) {
  return fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

module.exports = { extractWithSystemTar, findTarBinary, removeExtractionLeftovers };
