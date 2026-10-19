'use strict';

const fs = require('fs/promises');
const path = require('path');
const { isSidecarOf, isSupportedVideo } = require('./processor/formats');
const { recordSkipped } = require('./import-context');

/**
 * Tras abrir un comprimido, quita los subtitulos que NO acompanan a ningun
 * video de su misma carpeta. Al extraer, un subtitulo puede llegar antes que
 * su video (el orden dentro del archivo es arbitrario), asi que se guardan
 * todos y se limpian al final los huerfanos, que se cuentan como "no
 * compatibles" igual que un .srt suelto sin video.
 *
 * `sidecarPaths` y `mediaPaths`: rutas ya escritas en disco.
 */
async function pruneOrphanSidecars(sidecarPaths, mediaPaths, ctx) {
  if (sidecarPaths.length === 0) return;
  const videosByDir = new Map();
  for (const media of mediaPaths) {
    if (!isSupportedVideo(media)) continue;
    const dir = path.dirname(media);
    if (!videosByDir.has(dir)) videosByDir.set(dir, []);
    videosByDir.get(dir).push(media);
  }
  for (const sidecar of sidecarPaths) {
    const videos = videosByDir.get(path.dirname(sidecar)) || [];
    if (videos.some((video) => isSidecarOf(path.basename(sidecar), video))) continue;
    await fs.unlink(sidecar).catch(() => {});
    recordSkipped(ctx, sidecar);
  }
}

module.exports = { pruneOrphanSidecars };
