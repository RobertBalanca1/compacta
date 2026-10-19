'use strict';

const { isZipFile } = require('./processor/formats');
const { extractZip } = require('./zip-extractor');
const { extractWithSystemTar } = require('./system-archive');

/**
 * Punto de entrada unico para abrir un comprimido: reparte segun el formato.
 * El ZIP lo abre el extractor propio de la app; el resto (rar, 7z, tar, gz,
 * bz2, xz...) el "tar" del sistema. Los comprimidos anidados vuelven a pasar
 * por aqui, asi que un ZIP con un RAR dentro (o al reves) tambien funciona.
 */
async function extractArchive(archivePath, destDir, ctx, depth = 0) {
  ctx.extractArchive = extractArchive;
  return isZipFile(archivePath)
    ? extractZip(archivePath, destDir, ctx, depth)
    : extractWithSystemTar(archivePath, destDir, ctx, depth);
}

module.exports = { extractArchive };
