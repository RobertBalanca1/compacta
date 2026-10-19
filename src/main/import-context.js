'use strict';

const path = require('path');

/**
 * Estado compartido por una importacion completa: contadores de lo omitido o
 * fallido (para los avisos a la persona) y limites de seguridad al
 * descomprimir. Lo usan por igual el recorrido de carpetas (media-walker.js),
 * el descompresor (zip-extractor.js) y el importador (importer.js), por eso
 * vive en su propio modulo y no dentro de ninguno de ellos.
 */

const LIMITS = Object.freeze({
  maxEntries: 200000,
  maxEntryBytes: 16 * 1024 ** 3, // 16 GiB por archivo (un video largo pesa varios GB)
  maxTotalBytes: 100 * 1024 ** 3, // 100 GiB descomprimidos por importacion
  maxDepth: 3 // ZIP dentro de ZIP dentro de ZIP
});

/** Contexto compartido por todo lo que ocurre en UNA importacion (carpetas y ZIPs). */
function createContext(overrides = {}) {
  return {
    limits: { ...LIMITS, ...overrides },
    totalBytes: 0,
    entries: 0,
    skippedCount: 0,
    skippedExtensions: new Set(),
    failedArchives: [],
    archiveCount: 0,
    // Contrasena para los ZIP cifrados (solo cuando la persona la acaba de escribir; vive en memoria, nunca se guarda).
    password: null,
    // Lo fija el importador: reparte un comprimido anidado al extractor que
    // corresponda a su formato (ZIP propio o tar del sistema).
    extractArchive: null,
    failedCount: 0, // archivos que no se pudieron copiar
    duplicateCount: 0, // identicos a algo ya importado (se omiten): suma de las dos siguientes
    duplicateInDrop: 0, // repetidos dentro de la propia importacion
    duplicateBefore: 0, // identicos a algo anterior cuyo resultado sigue existiendo
    // Para poder ofrecer "Procesar de todos modos": de donde vino cada copia de input/ (solo los
    // archivos sueltos o de carpetas; lo que sale de un comprimido ya no tiene origen).
    sourceOf: new Map(),
    duplicateSources: []
  };
}

function recordSkipped(ctx, name) {
  ctx.skippedCount += 1;
  const ext = path.extname(name).toLowerCase();
  if (ext) ctx.skippedExtensions.add(ext);
}

module.exports = { createContext, recordSkipped };
