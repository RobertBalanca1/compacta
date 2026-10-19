'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { isJunkFile } = require('./processor/formats');
const { ArchiveError } = require('./archive-errors');
// La sanitizacion de nombres y los nombres sin colision los comparten el
// extractor de ZIP y el de comprimidos del sistema: por eso viven aqui.

/** Quita lo que Windows no admite en un nombre y lo que seria peligroso. */
function sanitizeSegment(segment) {
  return segment
    .replace(/[\u0000-\u001f<>:"|?*\\/]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
}

/**
 * Convierte el nombre de una entrada del ZIP en segmentos seguros. Devuelve
 * null si la entrada hay que ignorarla (basura del sistema) y lanza si es
 * un intento claro de escapar de la carpeta destino.
 */
function safeSegments(entryName) {
  const parts = entryName.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) return null;
  if (parts.some((p) => p === '..' || /^[a-zA-Z]:$/.test(p))) {
    throw new ArchiveError('unsafe-path', `ruta insegura en el comprimido: ${entryName}`);
  }
  if (parts.some((p) => isJunkFile(p))) return null;
  const cleaned = parts.map(sanitizeSegment);
  if (cleaned.some((p) => p === '')) return null;
  return cleaned;
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** foto.jpg -> foto (2).jpg -> foto (3).jpg ... sin pisar nada. */
async function uniqueFilePath(filePath) {
  if (!(await pathExists(filePath))) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  for (let n = 2; ; n += 1) {
    const candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
}

module.exports = { safeSegments, uniqueFilePath };
