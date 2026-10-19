'use strict';

// Un clip real de cada formato de video soportado, fabricado con el ffmpeg
// del proyecto. `args` son los codecs/muxer que lo producen. `optional`: si
// este ffmpeg no puede CREAR ese formato (aunque si lo lea), se omite en vez
// de fallar la prueba.

const { spawnSync } = require('child_process');
const { getFfmpegPath } = require('../../src/main/processor/ffmpeg');

const SRC = (size = '320x240', rate = 25) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=1`];
const AUDIO = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'];
const H264 = ['-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p'];

const FORMATS = [
  { ext: '.mp4', args: [...H264, '-c:a', 'aac'] },
  { ext: '.m4v', args: [...H264, '-c:a', 'aac', '-f', 'mp4'] },
  { ext: '.mov', args: [...H264, '-c:a', 'aac'] },
  { ext: '.qt', args: [...H264, '-c:a', 'aac', '-f', 'mov'] },
  { ext: '.mkv', args: [...H264, '-c:a', 'libopus'] },
  { ext: '.webm', args: ['-c:v', 'libvpx-vp9', '-crf', '15', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus'] },
  { ext: '.avi', args: ['-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'libmp3lame'] },
  { ext: '.divx', args: ['-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'libmp3lame', '-f', 'avi'] },
  { ext: '.wmv', args: ['-c:v', 'wmv2', '-q:v', '2', '-c:a', 'wmav2'] },
  { ext: '.asf', args: ['-c:v', 'wmv2', '-q:v', '2', '-c:a', 'wmav2', '-f', 'asf'] },
  { ext: '.flv', args: ['-c:v', 'flv', '-q:v', '2', '-c:a', 'libmp3lame', '-ar', '44100'] },
  { ext: '.f4v', args: [...H264, '-c:a', 'aac', '-f', 'flv'], optional: true },
  { ext: '.mpg', args: ['-c:v', 'mpeg2video', '-q:v', '2', '-c:a', 'mp2'] },
  { ext: '.mpeg', args: ['-c:v', 'mpeg1video', '-q:v', '2', '-c:a', 'mp2', '-f', 'mpeg'] },
  { ext: '.mpe', args: ['-c:v', 'mpeg1video', '-q:v', '2', '-c:a', 'mp2', '-f', 'mpeg'] },
  { ext: '.vob', args: ['-c:v', 'mpeg2video', '-q:v', '2', '-c:a', 'ac3', '-f', 'vob'] },
  { ext: '.m2v', args: ['-c:v', 'mpeg2video', '-q:v', '2', '-f', 'mpeg2video'], noAudio: true },
  { ext: '.3gp', args: [...H264, '-c:a', 'aac', '-f', '3gp'] },
  { ext: '.3g2', args: [...H264, '-c:a', 'aac', '-f', '3g2'] },
  { ext: '.mts', args: [...H264, '-c:a', 'ac3', '-f', 'mpegts'] },
  { ext: '.m2ts', args: [...H264, '-c:a', 'ac3', '-f', 'mpegts'] },
  { ext: '.ogv', args: ['-c:v', 'libtheora', '-q:v', '8', '-c:a', 'libvorbis'] },
  { ext: '.mxf', args: ['-c:v', 'mpeg2video', '-pix_fmt', 'yuv422p', '-q:v', '2', '-c:a', 'pcm_s16le', '-ar', '48000', '-f', 'mxf'], optional: true },
  { ext: '.dv', args: ['-c:v', 'dvvideo', '-pix_fmt', 'yuv420p', '-s', '720x576', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-f', 'dv'], size: '720x576', optional: true },
  { ext: '.rmvb', args: ['-c:v', 'rv20', '-q:v', '2', '-c:a', 'ac3', '-f', 'rm'], optional: true },
  { ext: '.rm', args: ['-c:v', 'rv20', '-q:v', '2', '-c:a', 'ac3', '-f', 'rm'], optional: true },
  // --- 1.0.12 ---
  { ext: '.3gpp', args: [...H264, '-c:a', 'aac', '-f', '3gp'] },
  { ext: '.3gpp2', args: [...H264, '-c:a', 'aac', '-f', '3g2'] },
  { ext: '.m2t', args: [...H264, '-c:a', 'ac3', '-f', 'mpegts'] },
  { ext: '.trp', args: [...H264, '-c:a', 'ac3', '-f', 'mpegts'] },
  { ext: '.tp', args: [...H264, '-c:a', 'ac3', '-f', 'mpegts'] },
  { ext: '.tod', args: ['-c:v', 'mpeg2video', '-q:v', '2', '-c:a', 'ac3', '-f', 'vob'] },
  { ext: '.vro', args: ['-c:v', 'mpeg2video', '-q:v', '2', '-c:a', 'ac3', '-f', 'vob'] },
  { ext: '.evo', args: ['-c:v', 'mpeg2video', '-q:v', '2', '-c:a', 'ac3', '-f', 'vob'] },
  { ext: '.m2p', args: ['-c:v', 'mpeg2video', '-q:v', '2', '-c:a', 'mp2', '-f', 'mpeg'] },
  { ext: '.dvr-ms', args: ['-c:v', 'wmv2', '-q:v', '2', '-c:a', 'wmav2', '-f', 'asf'] },
  { ext: '.ogm', args: ['-c:v', 'libtheora', '-q:v', '8', '-c:a', 'libvorbis', '-f', 'ogg'] },
  { ext: '.ivf', args: ['-c:v', 'libvpx', '-b:v', '800k', '-deadline', 'realtime', '-f', 'ivf'], noAudio: true },
  { ext: '.mk3d', args: [...H264, '-c:a', 'libopus', '-f', 'matroska'] },
  { ext: '.nut', args: ['-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'libmp3lame', '-f', 'nut'] },
  { ext: '.mpv', args: ['-c:v', 'mpeg1video', '-q:v', '2', '-f', 'mpeg1video'], noAudio: true },
  { ext: '.m1v', args: ['-c:v', 'mpeg1video', '-q:v', '2', '-f', 'mpeg1video'], noAudio: true },
  { ext: '.mjpeg', args: ['-c:v', 'mjpeg', '-q:v', '3', '-f', 'mjpeg'], noAudio: true },
  { ext: '.mjpg', args: ['-c:v', 'mjpeg', '-q:v', '3', '-f', 'mjpeg'], noAudio: true },
  { ext: '.gxf', args: ['-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p', '-s', '720x576', '-r', '25', '-c:a', 'pcm_s16le', '-ar', '48000', '-f', 'gxf'], size: '720x576', optional: true },
  { ext: '.y4m', args: ['-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe'], noAudio: true, optional: true } // el ffmpeg de Apple Silicon que se incluye no trae el muxer yuv4mpegpipe: no sabe CREARLO (la prueba se omite), leerlo no se ha podido comprobar ahi
];

/** Devuelve true si pudo crear el clip, false si este ffmpeg no sabe crear ese formato. */
function makeClip(format, outputPath) {
  const inputs = [...SRC(format.size), ...(format.noAudio ? [] : AUDIO)];
  const r = spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, ...format.args, outputPath], { encoding: 'utf8' });
  return r.status === 0;
}

/**
 * Algunas builds de ffmpeg se cierran con un fallo de segmentacion al LEER
 * ciertos contenedores (la build estatica de Linux con MPEG-TS). Eso no es un
 * defecto de Compacta y no tiene sentido fallar por ello; el binario de
 * Windows, que es el que se empaqueta, lee MPEG-TS bien. Se comprueba de
 * forma explicita (señal SIGSEGV), no se salta "por si acaso".
 */
function hostFfmpegCrashesReading(filePath) {
  const r = spawnSync(getFfmpegPath(), ['-hide_banner', '-i', filePath], { encoding: 'utf8' });
  return r.signal === 'SIGSEGV' || r.signal === 'SIGBUS';
}

module.exports = { FORMATS, makeClip, hostFfmpegCrashesReading };
