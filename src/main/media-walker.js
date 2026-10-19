'use strict';

const fs = require('fs/promises');
const path = require('path');
const { isSupportedMedia, isSupportedVideo, isSubtitleFile, isSidecarOf, isArchiveFile, isJunkFile } = require('./processor/formats');
const { recordSkipped } = require('./import-context');

/**
 * Recorrido de carpetas: encuentra las imagenes y videos que hay dentro, a
 * cualquier profundidad. Dos formas: una lista plana (para saber que hay en
 * input/) y un generador por carpetas (para importar progresivamente).
 */

// Profundidad maxima al recorrer carpetas (frena enlaces simbolicos en bucle).
const MAX_WALK_DEPTH = 64;

/**
 * Recorre un directorio una sola vez y devuelve todas las archivos
 * soportados (imagenes y videos) que contiene (a cualquier profundidad).
 */
async function walkMedia(dir, results = [], depth = 0) {
  if (depth > MAX_WALK_DEPTH) return results;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  const subdirs = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (isJunkFile(fullPath)) continue;
    if (entry.isDirectory()) subdirs.push(fullPath);
    else if (entry.isFile() && isSupportedMedia(fullPath)) results.push(fullPath);
  }
  for (const sub of subdirs) await walkMedia(sub, results, depth + 1);
  return results;
}

/**
 * Recorre una carpeta ORIGEN y va entregando "grupos": los archivos (y comprimidos)
 * de una misma carpeta. Es un generador a proposito: el primer grupo se
 * copia y se encola mientras todavia se esta leyendo el resto del arbol, en
 * vez de esperar a tenerlo todo listado.
 */
async function* walkGroups(srcDir, destDir, ctx, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true });
  } catch {
    ctx.failedCount += 1;
    return;
  }

  const files = [];
  const archives = [];
  const subtitles = [];
  const subdirs = [];

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    // Basura que crean solos macOS/Windows (.DS_Store, ._foto.jpg,
    // Thumbs.db, __MACOSX...): se ignora sin avisar, no es una foto del
    // usuario y avisar de ella solo asusta.
    if (isJunkFile(srcPath)) continue;

    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const real = await fs.stat(srcPath);
        isDir = real.isDirectory();
        isFile = real.isFile();
      } catch {
        continue; // enlace roto
      }
    }

    if (isDir) subdirs.push({ srcPath, name: entry.name });
    else if (isFile && isArchiveFile(srcPath)) archives.push(srcPath);
    else if (isFile && isSupportedMedia(srcPath)) files.push({ src: srcPath, dest: path.join(destDir, entry.name) });
    else if (isFile && isSubtitleFile(srcPath)) subtitles.push({ src: srcPath, name: entry.name });
    else if (isFile) recordSkipped(ctx, srcPath);
  }

  // Un subtitulo viaja con SU video (mismo nombre, en la misma carpeta); uno
  // sin video al lado es un archivo mas que no se puede comprimir.
  const videos = files.filter((f) => isSupportedVideo(f.src));
  const sidecars = [];
  for (const subtitle of subtitles) {
    if (videos.some((video) => isSidecarOf(subtitle.name, video.src))) sidecars.push({ src: subtitle.src, dest: path.join(destDir, subtitle.name) });
    else recordSkipped(ctx, subtitle.src);
  }

  if (files.length > 0 || archives.length > 0) yield { destDir, files, archives, sidecars };

  for (const sub of subdirs) {
    yield* walkGroups(sub.srcPath, path.join(destDir, sub.name), ctx, depth + 1);
  }
}

module.exports = { walkMedia, walkGroups };
