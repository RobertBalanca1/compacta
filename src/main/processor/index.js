'use strict';

const { mediaKind } = require('./formats');
const { optimizeImage } = require('./raster-optimizer');
const { optimizeVideo } = require('./video-optimizer');
const { optimizeAudio } = require('./audio-optimizer');
const { copySidecars } = require('./sidecars');

/**
 * Punto de entrada unico del procesador: elige el compresor segun el tipo de
 * archivo. La cola no necesita saber nada de imagenes, videos ni audios.
 * `onProgress(0..1)` lo usan los videos y los audios (una foto tarda un instante).
 */
async function processMedia(inputPath, outputPath, settings, onProgress) {
  const kind = mediaKind(inputPath);
  if (kind === 'audio') return optimizeAudio(inputPath, outputPath, settings, onProgress);
  if (kind !== 'video') return optimizeImage(inputPath, outputPath, settings);
  const report = await optimizeVideo(inputPath, outputPath, settings, onProgress);
  // Los subtitulos en archivo aparte viajan con su video (ver sidecars.js).
  report.sidecarCount = await copySidecars(inputPath, report.output);
  return report;
}

module.exports = { processMedia };
