'use strict';

const { getSharp } = require('../sharp-lazy');
const { openImage } = require('./heic');
const { t } = require('../../shared/i18n');
const fs = require('fs/promises');
const path = require('path');
const { getExtension, formatFromExtension, isPotentiallyAnimated, EXT_BY_FORMAT } = require('./formats');
const { withExtension, buildReport, atomicWrite, copyOriginal, chooseOutputPath } = require('./output-files');

// effort:6 en PNG da practicamente la misma compresion que effort:10
// (diferencia tipica <1%) en una fraccion del tiempo (medido: ~25-30% mas
// rapido). Con lotes grandes, esa diferencia es la que separa "un minuto"
// de "varios minutos" sin ceder espacio real de forma perceptible.
const PNG_EFFORT = 6;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function applyFormatEncoding(pipeline, targetFormat, sourceFormat, quality, aggressive, maxCompression) {
  const q = clamp(quality, 1, 100);
  // El modo agresivo debe notarse en TODOS los formatos, incluido JPEG (el
  // mas comun en fotos de celular). Bajamos la calidad efectiva un tramo
  // fijo en vez de dejarlo como si nada, que era el bug: antes "agresivo"
  // no tenia ningun efecto en JPEG porque el codigo simplemente no lo usaba.
  const aggressiveQuality = clamp(quality - 15, 40, 100);

  switch (targetFormat) {
    case 'jpeg': {
      const effectiveQuality = aggressive ? aggressiveQuality : q;
      // mozjpeg es ~10 veces mas lento que libjpeg-turbo (medido: ~1100 ms
      // vs ~115 ms por foto de 6 MP) para ahorrar solo ~7% mas de tamano a la
      // misma calidad visual. Por eso es opcional ("Compresion maxima"): por
      // defecto se usa libjpeg-turbo con codificacion Huffman optimizada, que
      // es lo que hace que un lote grande tarde minutos en vez de horas.
      return pipeline.jpeg({ quality: effectiveQuality, mozjpeg: maxCompression, optimiseCoding: true });
    }

    case 'png':
      return pipeline.png({
        compressionLevel: 9,
        effort: PNG_EFFORT,
        adaptiveFiltering: true,
        palette: aggressive,
        quality: aggressive ? q : undefined
      });

    case 'webp': {
      // "Sin perdida" solo tiene sentido si la imagen de ORIGEN ya era sin
      // perdida (PNG/TIFF). Convertir un JPEG (con perdida) a WebP sin
      // perdida casi siempre pesa MAS que el JPEG original, porque WebP
      // sin perdida tiene que guardar hasta el ruido de compresion que el
      // JPEG ya metio. Ese era el bug: al activar "Convertir a WebP" con
      // fotos normales (JPEG), el resultado siempre pesaba mas, la
      // salvaguarda anti-empeoramiento lo descartaba, y por eso parecia
      // que "no hacia nada".
      const sourceWasLossless = sourceFormat === 'png' || sourceFormat === 'tiff';
      const useLossless = sourceWasLossless && !aggressive;
      const effectiveQuality = aggressive ? aggressiveQuality : q;
      return pipeline.webp({ quality: effectiveQuality, lossless: useLossless, effort: 4 });
    }

    case 'tiff':
      return pipeline.tiff({ compression: 'lzw' });

    case 'avif': {
      // Igual que JPEG: si el archivo ya viene en AVIF, lo normal es que
      // ya sea una compresion con perdida, asi que reoptimizamos por
      // calidad en vez de forzar "sin perdida" (que rara vez encoge nada).
      const effectiveQuality = aggressive ? aggressiveQuality : q;
      // effort 3, no 4: medido en una foto de 2400 px, effort 4 tardaba ~13 s
      // y effort 3 ~1.3 s con el MISMO tamano de archivo (10x mas rapido sin
      // perder nada). Subir mas el esfuerzo no compensa en ningun caso.
      return pipeline.avif({ quality: effectiveQuality, lossless: false, effort: 3 });
    }

    case 'gif':
      return pipeline.gif();

    default:
      return pipeline;
  }
}

/**
 * Optimiza una sola imagen. Nunca deja el archivo de salida en peor estado
 * que el original: si la version optimizada no pesa menos, se copia el
 * original tal cual. Las imagenes animadas (gif/webp multi-frame) se
 * copian sin tocar para no perder ningun fotograma. Toda escritura es
 * atomica (ver atomicWrite).
 */
async function optimizeImage(inputPath, requestedOutputPath, options = {}) {
  const numericQuality = Number(options.quality);
  const quality = Number.isFinite(numericQuality) ? numericQuality : 90;
  const aggressive = !!options.aggressive;
  const convertToWebp = !!options.convertToWebp;
  const heicAlwaysJpg = !!options.heicAlwaysJpg; // HEIC -> JPG aunque pese mas (compatibilidad)
  const maxCompression = options.maxCompression === true;
  const outputPath = await chooseOutputPath(inputPath, requestedOutputPath);

  const originalStat = await fs.stat(inputPath);
  const originalBytes = originalStat.size;
  const ext = getExtension(inputPath);
  const sourceFormat = formatFromExtension(ext);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  if (isPotentiallyAnimated(inputPath)) {
    const meta = await getSharp()(inputPath, { animated: true }).metadata();
    if ((meta.pages || 1) > 1) {
      await copyOriginal(inputPath, outputPath);
      return buildReport(inputPath, outputPath, originalBytes, originalBytes, true, 'animacion-preservada');
    }
  }

  // Un HEIC sale como JPEG (o WebP si se pidio): el formato de origen no se puede volver a escribir.
  const isHeic = sourceFormat === 'heic';
  const targetFormat = (convertToWebp && sourceFormat !== 'webp') ? 'webp' : (isHeic ? 'jpeg' : sourceFormat);

  if (!targetFormat) {
    await copyOriginal(inputPath, outputPath);
    return buildReport(inputPath, outputPath, originalBytes, originalBytes, true, 'formato-no-soportado');
  }

  let pipeline = (await openImage(inputPath, { failOn: 'none' })).rotate();
  // Un HEIC puede traer transparencia y JPEG no la admite: se aplana sobre blanco (sin transparencia no cambia nada).
  if (isHeic && targetFormat === 'jpeg') pipeline = pipeline.flatten({ background: '#ffffff' });
  pipeline = applyFormatEncoding(pipeline, targetFormat, sourceFormat, quality, aggressive, maxCompression);

  const finalOutputPath = withExtension(outputPath, EXT_BY_FORMAT[targetFormat]);
  const buffer = await pipeline.toBuffer();

  // Con `heicAlwaysJpg`, un HEIC se convierte aunque salga mas pesado: la persona pidio compatibilidad, no ahorro.
  const forcedHeic = isHeic && heicAlwaysJpg;
  if (buffer.length >= originalBytes && !forcedHeic) {
    await copyOriginal(inputPath, outputPath);
    // HEIC ya es muy eficiente: pasarlo a JPEG/WebP suele pesar MAS, y entonces se conserva tal cual.
    return buildReport(inputPath, outputPath, originalBytes, originalBytes, true, isHeic ? 'heic-eficiente' : 'sin-mejora-posible');
  }

  await atomicWrite(finalOutputPath, (tmp) => fs.writeFile(tmp, buffer));
  const report = buildReport(inputPath, finalOutputPath, originalBytes, buffer.length, false, null);
  // Un HEIC pasado a JPG que pesa MAS (solo con la opcion de compatibilidad): se explica en la fila.
  return forcedHeic && buffer.length >= originalBytes ? { ...report, detail: t('detail.heicToJpg') } : report;
}

module.exports = { optimizeImage };
