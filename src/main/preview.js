'use strict';

const { t } = require('../shared/i18n');

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getSharp } = require('./sharp-lazy');
const { openImage } = require('./processor/heic');
const { probeVideo, runFfmpeg } = require('./processor/ffmpeg');

/**
 * Vista previa "antes y despues" de una foto ya procesada.
 *
 * Reglas (heredadas de una mala experiencia: las miniaturas de la lista se
 * veian mal en un Windows concreto y se quitaron, ver doc 7.11):
 *  - Solo se pide al hacer clic, nunca para toda la lista.
 *  - Nunca se manda la foto original completa a la pantalla: se reduce aqui,
 *    con sharp, a un maximo de 1400 px y se entrega ya como JPEG en base64.
 *    Una foto de 50 megapixeles no llega a la ventana.
 *  - Se aplica la orientacion EXIF (si no, una foto de movil en vertical
 *    saldria de lado en la vista previa aunque este bien en el archivo).
 */

const PREVIEW_MAX_SIDE = 1400;
// Detalle al 100 %: lado maximo de la zona recortada (en pixeles de la foto).
const DETAIL_MAX_SIDE = 2400;
const DETAIL_MIN_SIDE = 64;

async function renderSide(filePath) {
  const bytes = (await fs.stat(filePath)).size;
  // failOn: 'none' -> una foto con un defecto leve igualmente se muestra.
  const image = (await openImage(filePath)).rotate();
  const { data, info } = await image
    .resize({ width: PREVIEW_MAX_SIDE, height: PREVIEW_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    // 4:4:4 y calidad alta: la vista general no debe anadir ella misma defectos de
    // color/compresion que confundan al comparar (los de verdad se ven en el detalle al 100 %).
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer({ resolveWithObject: true });
  // Medidas reales del ARCHIVO (no de la vista reducida), para mostrarlas.
  const meta = await (await openImage(filePath)).metadata();
  const swapped = meta.orientation && meta.orientation >= 5;
  return {
    dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`,
    previewWidth: info.width,
    previewHeight: info.height,
    width: swapped ? meta.height : meta.width,
    height: swapped ? meta.width : meta.height,
    bytes
  };
}

/**
 * VIDEOS: se compara UN fotograma (hacia el 10 % de la duracion) del original y del resultado,
 * extraido con ffmpeg a un archivo temporal que se borra enseguida. Sirve para ver la calidad;
 * no hay detalle al 100 % ni se reproduce el video.
 */
async function renderVideoFrame(filePath, atSec) {
  const bytes = (await fs.stat(filePath)).size;
  const tmpFile = path.join(os.tmpdir(), `compacta-frame-${crypto.randomBytes(6).toString('hex')}.jpg`);
  try {
    await runFfmpeg(['-ss', atSec.toFixed(2), '-i', filePath, '-frames:v', '1', '-an', '-sn',
      '-vf', `scale='min(${PREVIEW_MAX_SIDE},iw)':'min(${PREVIEW_MAX_SIDE},ih)':force_original_aspect_ratio=decrease:out_range=pc`, '-q:v', '2', tmpFile]);
    const data = await fs.readFile(tmpFile);
    const meta = await getSharp()(data).metadata();
    return { dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`, previewWidth: meta.width, previewHeight: meta.height, bytes };
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

async function buildVideoPreview(job) {
  try {
    const info = await probeVideo(job.inputPath);
    if (!info.hasVideo) throw new Error('sin imagen');
    const atSec = info.durationSec > 0 ? Math.min(Math.max(info.durationSec * 0.1, 0.3), Math.max(info.durationSec - 0.2, 0)) : 0;
    const [before, after] = await Promise.all([renderVideoFrame(job.inputPath, atSec), renderVideoFrame(job.report.output, atSec)]);
    // Medidas reales del video (no del fotograma reducido).
    for (const side of [before, after]) {
      side.width = info.width || side.previewWidth;
      side.height = info.height || side.previewHeight;
    }
    return { before, after, video: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new Error(t('preview.err.noFile'));
    throw new Error(t('preview.err.noFrame'));
  }
}

/** job: { kind, status, inputPath, report }. Lanza un Error con un mensaje para la persona si no se puede. */
async function buildPreview(job) {
  if (!job) throw new Error(t('preview.err.notInList'));
  if (job.kind === 'audio') throw new Error(t('preview.err.audio'));
  if (job.status !== 'done' || !job.report) throw new Error(t(job.kind === 'video' ? 'preview.err.videoNotReady' : 'preview.err.photoNotReady'));
  if (job.kind === 'video') return buildVideoPreview(job);
  try {
    const [before, after] = await Promise.all([renderSide(job.inputPath), renderSide(job.report.output)]);
    return { before, after };
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new Error(t('preview.err.noFile'));
    throw new Error(t('preview.err.photoFailed'));
  }
}

/** Medidas de la foto TAL COMO SE VE (con la orientacion EXIF ya aplicada). */
async function orientedSize(filePath) {
  const meta = await (await openImage(filePath)).metadata();
  const swapped = meta.orientation && meta.orientation >= 5;
  return { width: swapped ? meta.height : meta.width, height: swapped ? meta.width : meta.height };
}

/**
 * Detalle al 100 %: un recorte de la foto SIN reducir, de la original y del
 * resultado, de la MISMA zona. Es lo unico que deja ver de verdad lo que hizo la
 * compresion (la vista general esta reducida y los defectos finos desaparecen al
 * reducir). Va como PNG (sin perdida): un JPEG aqui anadiria defectos propios.
 *
 * `request`: { cx, cy, width, height }  (cx/cy = centro, entre 0 y 1; width/height = pixeles de la foto)
 */
async function buildDetail(job, request) {
  if (!job || job.kind === 'video' || job.kind === 'audio') throw new Error(t('preview.err.detailPhotosOnly'));
  if (job.status !== 'done' || !job.report) throw new Error(t('preview.err.photoNotReady'));
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const cx = Math.min(1, Math.max(0, number(request && request.cx, 0.5)));
  const cy = Math.min(1, Math.max(0, number(request && request.cy, 0.5)));
  const wantW = Math.round(Math.min(DETAIL_MAX_SIDE, Math.max(DETAIL_MIN_SIDE, number(request && request.width, 900))));
  const wantH = Math.round(Math.min(DETAIL_MAX_SIDE, Math.max(DETAIL_MIN_SIDE, number(request && request.height, 600))));
  try {
    const size = await orientedSize(job.inputPath);
    const width = Math.min(wantW, size.width);
    const height = Math.min(wantH, size.height);
    // Centrada en el punto pedido, sin salirse de la foto.
    const left = Math.min(size.width - width, Math.max(0, Math.round(cx * size.width - width / 2)));
    const top = Math.min(size.height - height, Math.max(0, Math.round(cy * size.height - height / 2)));
    const region = { left, top, width, height };
    const crop = async (filePath) => {
      // rotate() ANTES de extract(): la zona se mide sobre la foto como se ve, no como esta guardada.
      const data = await (await openImage(filePath))
        .rotate()
        .extract(region)
        .png({ compressionLevel: 1 })
        .toBuffer();
      return `data:image/png;base64,${data.toString('base64')}`;
    };
    const [before, after] = await Promise.all([crop(job.inputPath), crop(job.report.output)]);
    return { before, after, region, imageWidth: size.width, imageHeight: size.height };
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new Error(t('preview.err.noFile'));
    throw new Error(t('preview.err.detailFailed'));
  }
}

module.exports = { buildPreview, buildDetail, PREVIEW_MAX_SIDE, DETAIL_MAX_SIDE };
