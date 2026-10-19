'use strict';

const { t } = require('../../shared/i18n');

const fs = require('fs/promises');
const path = require('path');
const { withExtension, buildReport, tempPathFor, renameWithRetry, copyOriginal, chooseOutputPath } = require('./output-files');
const { probeVideo, runFfmpeg, captureFfmpeg } = require('./ffmpeg');
const { optimizeAudio } = require('./audio-optimizer');
const { RAW_VIDEO_EXTENSIONS, getExtension } = require('./formats');

/**
 * Compresion de video con la MISMA logica que las imagenes: la calidad, el
 * "modo agresivo" y la "compresion maxima" de Ajustes se traducen aqui a
 * parametros de ffmpeg, y el resultado nunca es peor que el original.
 *
 * Que se hace para NO perder calidad:
 *  - Codificacion por CALIDAD CONSTANTE (CRF), no por tasa de bits fija: cada
 *    escena recibe los bits que necesita para verse igual de bien; el tamano
 *    final es consecuencia, no una apuesta.
 *  - Se conservan resolucion, fotogramas por segundo (incluido el variable de
 *    los moviles), metadatos y todas las pistas de audio. Nunca se reescala.
 *  - Un video HEVC (H.265) o de mas de 8 bits (HDR de iPhone, 10 bits) se
 *    recodifica en HEVC conservando los bits y el color: pasarlo a H.264 de
 *    8 bits le quitaria el HDR y se veria apagado.
 *  - El audio AAC/MP3 se COPIA sin recodificar (cero perdida). Solo se
 *    recodifica a AAC si venia en otro formato que MP4 no admite.
 *  - Los SUBTITULOS no se pierden nunca: los de texto simple (SRT, WebVTT)
 *    van dentro del MP4; si hay alguno que el MP4 no puede guardar (ASS/SSA
 *    con estilos, o de imagen como PGS de Blu-ray y VobSub de DVD), el video
 *    sale como MKV, que los guarda todos, copiandolos tal cual (con su idioma
 *    y sus marcas de "forzado"/"por defecto"). Un MKV tambien conserva el
 *    audio en su formato original, sea cual sea.
 */

// Cuanto tiene que ahorrar como minimo para quedarse con el resultado. Un
// video ya bien comprimido apenas encoge al recodificarlo, y cada
// recodificacion con perdida acumula degradacion: por debajo de este umbral
// es mejor conservar el original intacto.
const MIN_SAVING_RATIO = 0.05;

// Audio que MP4 acepta tal cual y que por tanto se copia sin tocar.
const COPYABLE_AUDIO = new Set(['aac', 'mp3']);

// Subtitulos de texto simple: caben en un MP4 (se guardan como mov_text, sin
// perder ni una linea; solo se pierde el estilo avanzado, que estos no tienen).
const MP4_SUBTITLES = new Set(['subrip', 'srt', 'mov_text', 'webvtt', 'text']);
// Subtitulos que un MKV guarda tal cual. Un codec que no este aqui (p. ej.
// los "closed captions" EIA-608, que ya van dentro de la propia imagen del
// video y se conservan al recodificar) no se mapea como pista.
const MKV_SUBTITLES = new Set([...MP4_SUBTITLES, 'ass', 'ssa', 'dvd_subtitle', 'dvdsub', 'hdmv_pgs_subtitle', 'pgssub', 'dvb_subtitle', 'dvbsub', 'xsub']);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Calidad (la misma barra de 60-100 que las fotos) -> CRF de x264. 100 es
 * practicamente transparente (CRF 17), 90 (la opcion por defecto) es una
 * calidad visual indistinguible a simple vista (CRF 20), y cada punto menos
 * sube el CRF 0,3. "Agresivo" resta el mismo tramo de calidad que en JPEG.
 * x265 llega a la misma calidad con un CRF unos 5 puntos mas alto.
 */
function crfFor(quality, aggressive, codec) {
  const q = clamp(Number.isFinite(quality) ? quality : 90, 1, 100);
  const effective = aggressive ? clamp(q - 15, 40, 100) : q;
  const crf264 = clamp(Math.round(17 + (100 - effective) * 0.3), 16, 36);
  return codec === 'x265' ? crf264 + 5 : crf264;
}

/**
 * HEVC o 8+ bits de color: se recodifica en HEVC para no perder HDR ni profundidad. Tambien VP9 y AV1
 * (descargas en WebM/MKV, grabaciones de pantalla): son codecs mas eficientes que H.264, y recodificarlos
 * en H.264 casi siempre pesaria mas y el resultado se descartaria tras minutos de trabajo.
 */
function shouldUseHevc(probe) {
  return probe.videoCodec === 'hevc' || probe.videoCodec === 'vp9' || probe.videoCodec === 'av1'
    || /(?:10|12)(?:le|be)?$/.test(probe.pixFmt || '');
}

/**
 * Decide el contenedor de salida segun los subtitulos del original (ver el
 * comentario del principio) y cuales se conservan. Funcion pura.
 */
function planContainer(probe) {
  const subtitles = (probe.subtitles || []).filter((s) => MKV_SUBTITLES.has(s.codec));
  const needsMkv = subtitles.some((s) => !MP4_SUBTITLES.has(s.codec));
  return needsMkv
    ? { extension: '.mkv', format: 'matroska', subtitles }
    : { extension: '.mp4', format: 'mp4', subtitles };
}

/** Argumentos del CODIFICADOR de video (x264 o x265, preset, CRF, color). Los comparten el archivo real y la prueba de peso. */
function videoCodecArgs(probe, options, isMp4) {
  const aggressive = !!options.aggressive;
  const hevc = shouldUseHevc(probe);
  const highBitDepth = /(?:10|12)(?:le|be)?$/.test(probe.pixFmt || '');
  const crf = String(crfFor(Number(options.quality), aggressive, hevc ? 'x265' : 'x264'));
  const maxCompression = options.maxCompression === true;
  if (hevc) {
    // "fast" y "medium" son los puntos donde x265 deja de ser desproporcionadamente lento.
    // Se conservan los bits de color (8 o 10) pero siempre en 4:2:0, el unico
    // submuestreo que reproducen televisores, moviles y Windows; un ProRes
    // 4:2:2 o un 4:4:4 no se verian en la mayoria de reproductores.
    return ['-c:v', 'libx265', '-preset', maxCompression ? 'medium' : 'fast', '-crf', crf,
      '-pix_fmt', highBitDepth ? 'yuv420p10le' : 'yuv420p', ...(isMp4 ? ['-tag:v', 'hvc1'] : []), '-x265-params', 'log-level=error'];
  }
  return ['-c:v', 'libx264', '-preset', maxCompression ? 'slow' : 'fast', '-crf', crf, '-pix_fmt', 'yuv420p'];
}

/**
 * Filtros, en este orden: desentrelazar (solo los fotogramas que de verdad lo estan) y, si el ancho o el
 * alto son impares, anadir UN pixel de borde (el 4:2:0 exige tamanos pares) en vez de recortar contenido.
 */
function videoFilterArgs(probe) {
  const filters = [];
  if (probe.interlaced) filters.push('yadif=0:-1:0');
  if (probe.width % 2 !== 0 || probe.height % 2 !== 0) filters.push('pad=ceil(iw/2)*2:ceil(ih/2)*2');
  return filters.length > 0 ? ['-vf', filters.join(',')] : [];
}

/**
 * Construye los argumentos de ffmpeg. Es una funcion pura (datos -> lista de
 * argumentos): se prueba entera sin ejecutar nada.
 */
function buildVideoArgs(probe, options, inputPath, outputPath) {
  const plan = planContainer(probe);
  const isMp4 = plan.format === 'mp4';

  const args = ['-i', inputPath, '-map', '0:v:0', '-map', '0:a?'];
  for (const subtitle of plan.subtitles) args.push('-map', `0:${subtitle.index}`);
  // Fuentes incrustadas (las usan los subtitulos ASS): solo caben en MKV.
  if (!isMp4) args.push('-map', '0:t?');
  args.push('-map_metadata', '0');

  args.push(...videoCodecArgs(probe, options, plan.format === 'mp4'), ...videoFilterArgs(probe));

  // En MKV cabe el audio de cualquier formato: siempre se copia, sin perdida.
  const copyAudio = !isMp4 || probe.audio.every((a) => COPYABLE_AUDIO.has(a.codec));
  if (copyAudio) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-b:a', probe.audio.some((a) => a.heavy) ? '384k' : '160k');
  }

  if (plan.subtitles.length > 0) args.push('-c:s', isMp4 ? 'mov_text' : 'copy');

  // passthrough: no duplicar ni descartar fotogramas (conserva el ritmo real
  // de grabacion). faststart (solo MP4): el video empieza a verse sin esperar
  // a bajarlo entero.
  args.push('-fps_mode', 'passthrough');
  if (isMp4) args.push('-movflags', '+faststart');
  args.push('-f', plan.format, outputPath);
  return args;
}

// ---- Prueba de peso: ¿merece la pena codificar este video entero? ----
// Codificar un video largo son minutos (o una hora). Si el original ya esta bien comprimido (una descarga
// VP9/AV1, un MP4 de redes sociales), el resultado pesara MAS o casi igual y se descartara al final: tiempo
// perdido. Una prueba con dos trozos cortos, con EXACTAMENTE los mismos ajustes, lo detecta en segundos.
const TRIAL_MIN_SECONDS = 180;   // por debajo, codificar entero cuesta casi lo mismo que probar
const TRIAL_WINDOW_SECONDS = 8;
const TRIAL_POSITIONS = [0.35, 0.7];
// Solo se salta cuando la prueba dice que pesara un 10 % MAS que el original (no solo "no ahorra"): el error de
// estimar con dos trozos es de ese orden, y saltarse un video que si ahorraba pierde ahorro; codificar de mas solo pierde tiempo.
const TRIAL_SKIP_RATIO = 1.1;

/** Argumentos de la codificacion de PRUEBA de un trozo (solo video, flujo en bruto a un pipe). Funcion pura. */
function buildVideoTrialArgs(probe, options, inputPath, window) {
  const raw = shouldUseHevc(probe) ? 'hevc' : 'h264';
  return ['-ss', String(window.start), '-t', String(window.length), '-i', inputPath, '-map', '0:v:0',
    ...videoCodecArgs(probe, options, false), ...videoFilterArgs(probe), '-an', '-fps_mode', 'passthrough', '-f', raw, 'pipe:1'];
}

/**
 * Cuanto pesaria el video completo (kbps de video + audio de salida) respecto al original, segun la prueba:
 * una razon (1 = igual, 1,3 = un 30 % mas). null si no aplica o no se pudo medir. El audio de salida es el mismo
 * si se copia, o ~160 kbps si hay que pasarlo a AAC.
 */
async function projectedSizeRatio(probe, options, inputPath, originalBytes) {
  if (!(probe.durationSec >= TRIAL_MIN_SECONDS)) return null;
  const durationKbps = (originalBytes * 8) / 1000 / probe.durationSec;
  try {
    const parts = await Promise.all(TRIAL_POSITIONS.map(async (fraction) => {
      const start = Math.max(0, Math.min(probe.durationSec - TRIAL_WINDOW_SECONDS, probe.durationSec * fraction));
      const out = await captureFfmpeg(buildVideoTrialArgs(probe, options, inputPath, { start, length: TRIAL_WINDOW_SECONDS }));
      return out.length;
    }));
    const videoKbps = (parts.reduce((a, b) => a + b, 0) * 8) / 1000 / (TRIAL_POSITIONS.length * TRIAL_WINDOW_SECONDS);
    const plan = planContainer(probe);
    const sourceAudio = probe.audio.reduce((sum, a) => sum + (a.bitrateKbps || 0), 0);
    const copyAudio = plan.format !== 'mp4' || probe.audio.every((a) => COPYABLE_AUDIO.has(a.codec));
    const outAudio = copyAudio ? sourceAudio : (probe.audio.length > 0 ? (probe.audio.some((a) => a.heavy) ? 384 : 160) : 0);
    return videoKbps > 0 ? (videoKbps + outAudio) / durationKbps : null;
  } catch {
    return null;
  }
}

/**
 * Comprime un video. `onProgress(0..1)` informa del avance. Escribe de forma
 * atomica (temporal + renombrar) igual que las imagenes, y si el resultado no
 * ahorra lo suficiente, deja el original sin tocar.
 */
async function optimizeVideo(inputPath, requestedOutputPath, options = {}, onProgress) {
  const outputPath = await chooseOutputPath(inputPath, requestedOutputPath);
  const originalBytes = (await fs.stat(inputPath)).size;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const probe = await probeVideo(inputPath);
  if (RAW_VIDEO_EXTENSIONS.has(getExtension(inputPath))) probe.durationSec = 0; // ver formats.js
  // Sin ninguna pista ni duracion: ffmpeg no entendio el archivo (corrupto o
  // no es un video). Se avisa como error, igual que una foto danada; copiarlo
  // y decir "sin cambios" haria creer que esta bien.
  if (!probe.hasVideo && probe.audio.length === 0 && probe.durationSec === 0) {
    throw new Error(t('media.badVideo'));
  }
  // Dos pistas de video reales (3D, angulos de camara): Compacta guarda una sola, asi que se perderia
  // contenido. Ante la duda, intacto.
  if (probe.hasVideo && probe.extraVideoStreams > 0) {
    await copyOriginal(inputPath, outputPath);
    return buildReport(inputPath, outputPath, originalBytes, originalBytes, true, 'varios-videos');
  }
  // Un .mp4/.3gp/.webm/.mkv que solo lleva sonido (nota de voz, grabacion) es un AUDIO:
  // se comprime como tal en vez de copiarlo sin tocar.
  if (!probe.hasVideo && probe.audio.length > 0) return optimizeAudio(inputPath, requestedOutputPath, options, onProgress, probe);
  if (!probe.hasVideo) {
    await copyOriginal(inputPath, outputPath);
    return buildReport(inputPath, outputPath, originalBytes, originalBytes, true, 'formato-no-soportado');
  }

  // ¿Pesara mas que el original? Entonces no se gasta el tiempo de codificarlo entero.
  const ratio = await projectedSizeRatio(probe, options, inputPath, originalBytes);
  if (ratio !== null && ratio >= TRIAL_SKIP_RATIO) {
    await copyOriginal(inputPath, outputPath);
    return buildReport(inputPath, outputPath, originalBytes, originalBytes, true, 'ya-optimizado');
  }

  const finalPath = withExtension(outputPath, planContainer(probe).extension);
  const tmpPath = tempPathFor(finalPath);
  try {
    await runFfmpeg(buildVideoArgs(probe, options, inputPath, tmpPath), { durationSec: probe.durationSec, onProgress });
    const newBytes = (await fs.stat(tmpPath)).size;

    if (newBytes > originalBytes * (1 - MIN_SAVING_RATIO)) {
      await fs.unlink(tmpPath).catch(() => {});
      await copyOriginal(inputPath, outputPath);
      return buildReport(inputPath, outputPath, originalBytes, originalBytes, true, 'sin-mejora-posible');
    }

    await renameWithRetry(tmpPath, finalPath);
    return buildReport(inputPath, finalPath, originalBytes, newBytes, false, null);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

module.exports = { optimizeVideo, buildVideoArgs, buildVideoTrialArgs, projectedSizeRatio, planContainer, crfFor };
