'use strict';

const { captureFfmpeg } = require('./ffmpeg');

/**
 * Mediciones sobre el audio ANTES de decidir como comprimirlo. Todo se hace con ffmpeg sobre
 * unas pocas muestras del archivo (no sobre el archivo entero), asi que cuesta una fraccion de
 * segundo incluso en una grabacion de horas:
 *
 *  1. `analyzeChannels`: ¿el "estereo" es de verdad estereo? Muchas grabaciones de voz, micros
 *     USB y archivos de WhatsApp/Zoom se guardan en estereo con el MISMO sonido en los dos
 *     canales (o con un canal vacio). Guardarlas en mono es la mitad de peso sin cambiar nada de
 *     lo que se oye. Se mide la energia del canal "lateral" (L-R) frente al "central" (L+R).
 *  2. `estimateKbps`: codificacion de PRUEBA (rapida) de las mismas muestras con los ajustes elegidos.
 *     MP3 y Vorbis son de calidad variable: lo que pesan depende del propio sonido (una voz limpia
 *     pesa la mitad que una orquesta con el mismo ajuste). En vez de suponerlo con una tabla,
 *     se mide, y asi se decide con datos si recodificar un audio que ya viene comprimido compensa.
 */

// Muestras (lanzar un ffmpeg cuesta, sobre todo en Windows, con el antivirus mirando cada arranque: por eso
// TODOS los trozos de un archivo se leen con UN solo ffmpeg, ver `buildChannelAnalysisArgs`): un archivo corto se mira entero
// (hasta SAMPLE_WHOLE_SECONDS); uno de hasta 10 minutos (una cancion, una charla corta), en dos trozos de
// 15 s al 30 % y al 70 %; uno largo (una predicacion, un concierto), en tres trozos de 12 s al 20 %, 50 % y 80 %
// para no fiarse solo del principio (empieza con musica y silencio; o con aplausos).
const SAMPLE_WHOLE_SECONDS = 45;
const MEDIUM_FILE_SECONDS = 600;
const ANALYSIS_RATE = 16000;
const TRIAL_WINDOW_SECONDS = 10;
// Por debajo de este nivel (dBFS) un trozo se considera silencio y no cuenta.
const SILENCE_DB = -65;
// Un canal que esta tantos dB por debajo del otro se considera vacio.
const EMPTY_CHANNEL_DB = 50;

/**
 * Trozos a muestrear: [{ start, length }] en segundos. Funcion pura. `maxLength` los acorta (la prueba de peso
 * codifica, y codificar cuesta mas que mirar: le bastan 10 s por trozo para estimar la tasa).
 */
function sampleWindows(durationSec, maxLength = Infinity) {
  if (!(durationSec > SAMPLE_WHOLE_SECONDS)) return [{ start: 0, length: Math.min(SAMPLE_WHOLE_SECONDS, maxLength) }];
  const [positions, base] = durationSec <= MEDIUM_FILE_SECONDS ? [[0.3, 0.7], 15] : [[0.2, 0.5, 0.8], 12];
  const length = Math.min(base, maxLength);
  return positions.map((fraction) => ({ start: Math.max(0, Math.min(durationSec - length, durationSec * fraction)), length }));
}

const toDb = (power) => (power > 0 ? 10 * Math.log10(power) : -Infinity);

/**
 * Energias de un trozo de PCM estereo (s16le entrelazado): izquierda, derecha, central y lateral.
 * Funcion pura (bytes -> numeros): se prueba sin ffmpeg.
 */
function stereoEnergies(pcm) {
  const view = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4) * 2);
  let left = 0;
  let right = 0;
  let mid = 0;
  let side = 0;
  for (let i = 0; i + 1 < view.length; i += 2) {
    const l = view[i] / 32768;
    const r = view[i + 1] / 32768;
    left += l * l;
    right += r * r;
    const m = (l + r) / 2;
    const s = (l - r) / 2;
    mid += m * m;
    side += s * s;
  }
  const frames = Math.floor(view.length / 2) || 1;
  return { left: left / frames, right: right / frames, mid: mid / frames, side: side / frames };
}

/**
 * Decide como guardar los canales a partir de las energias de cada trozo. Funcion pura.
 *  - 'left' / 'right': el otro canal esta vacio -> se guarda el que suena, en mono.
 *  - 'mix': los dos son (casi) iguales -> mono con la mezcla de ambos.
 *  - 'stereo': estereo de verdad, no se toca.
 * `maxSideDb`: cuanto puede pesar el canal lateral frente al central (en dB, negativo) para
 * seguir considerandolo mono. Es el UNICO criterio que se usa para musica; es estricto a proposito.
 */
function decideChannels(windows, maxSideDb) {
  const audible = windows.filter((w) => toDb(Math.max(w.left, w.right)) > SILENCE_DB);
  if (audible.length === 0) return { mode: 'stereo', sideDb: null };

  // Canal vacio en TODOS los trozos con sonido.
  const emptyRight = audible.every((w) => toDb(w.left) - toDb(w.right) >= EMPTY_CHANNEL_DB);
  const emptyLeft = audible.every((w) => toDb(w.right) - toDb(w.left) >= EMPTY_CHANNEL_DB);
  if (emptyRight) return { mode: 'left', sideDb: null };
  if (emptyLeft) return { mode: 'right', sideDb: null };

  // El peor trozo manda: basta uno con estereo real para no tocar nada.
  let worst = -Infinity;
  for (const w of audible) worst = Math.max(worst, toDb(w.side) - toDb(w.mid));
  return { mode: worst <= maxSideDb ? 'mix' : 'stereo', sideDb: worst };
}

/** Argumentos de entrada de ffmpeg para leer varios trozos del mismo archivo. */
function windowInputArgs(inputPath, windows) {
  return windows.flatMap((window) => ['-ss', String(window.start), '-t', String(window.length), '-i', inputPath]);
}

/**
 * Argumentos de UN solo ffmpeg que lee todos los trozos y los entrega seguidos como PCM estereo. Cada trozo se
 * rellena con silencio hasta su duracion exacta (`apad` + `atrim`), asi que todos ocupan los mismos bytes y se
 * pueden separar despues (`splitPcm`); un relleno de silencio nunca cuenta como sonido (ver SILENCE_DB).
 * Antes eran 2 o 3 procesos de ffmpeg por archivo (uno por trozo). Funcion pura.
 */
function buildChannelAnalysisArgs(inputPath, windows) {
  const out = ['-ac', '2', '-ar', String(ANALYSIS_RATE), '-f', 's16le', 'pipe:1'];
  if (windows.length === 1) return [...windowInputArgs(inputPath, windows), '-map', '0:a:0', '-vn', ...out];
  const prepare = windows.map((window, i) => `[${i}:a:0]aformat=channel_layouts=stereo,aresample=${ANALYSIS_RATE},apad=whole_dur=${window.length},atrim=end=${window.length}[w${i}]`);
  const join = `${windows.map((_, i) => `[w${i}]`).join('')}concat=n=${windows.length}:v=0:a=1[out]`;
  return [...windowInputArgs(inputPath, windows), '-filter_complex', [...prepare, join].join(';'), '-map', '[out]', ...out];
}

/** Reparte el PCM de `count` trozos de igual duracion (s16le estereo: 4 bytes por muestra). Funcion pura. */
function splitPcm(pcm, count) {
  const each = Math.floor(pcm.length / count / 4) * 4;
  return Array.from({ length: count }, (_, i) => pcm.subarray(i * each, (i + 1) * each));
}

/**
 * Mide los canales del archivo. Solo tiene sentido con exactamente 2 canales (si no, se devuelve
 * 'stereo' = no tocar). Si ffmpeg falla al leer una muestra, ante la duda NO se toca nada.
 */
async function analyzeChannels(inputPath, durationSec, maxSideDb) {
  try {
    const windows = sampleWindows(durationSec);
    const pcm = await captureFfmpeg(buildChannelAnalysisArgs(inputPath, windows));
    const energies = splitPcm(pcm, windows.length).map((part) => (part.length >= 4 ? stereoEnergies(part) : null));
    return decideChannels(energies.filter(Boolean), maxSideDb);
  } catch {
    return { mode: 'stereo', sideDb: null };
  }
}

/**
 * Tasa de bits (kbps) que saldria de codificar las muestras del archivo con estos argumentos.
 * `buildArgs(windows)` devuelve los argumentos de ffmpeg para TODOS los trozos a la vez (uno solo
 * ffmpeg; ya con `-f <contenedor> pipe:1`). Devuelve null si no se pudo medir (el llamador usa
 * entonces su tabla).
 */
async function estimateKbps(buildArgs, durationSec) {
  try {
    const windows = sampleWindows(durationSec, TRIAL_WINDOW_SECONDS).map((window) => ({
      start: window.start,
      length: durationSec > 0 ? Math.min(window.length, durationSec - window.start) : window.length
    }));
    const out = await captureFfmpeg(buildArgs(windows));
    const seconds = windows.reduce((sum, window) => sum + window.length, 0);
    return seconds > 0 && out.length > 0 ? (out.length * 8) / 1000 / seconds : null;
  } catch {
    return null;
  }
}

module.exports = { sampleWindows, stereoEnergies, decideChannels, buildChannelAnalysisArgs, splitPcm, analyzeChannels, estimateKbps };
