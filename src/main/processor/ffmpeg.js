'use strict';

const { t } = require('../../shared/i18n');

/**
 * Acceso a ffmpeg: localizar el binario, inspeccionar un video y ejecutar una
 * codificacion con progreso. No sabe NADA de calidad ni de ajustes (eso es de
 * video-optimizer.js): solo lanza procesos y traduce su salida.
 */

const { spawn, spawnSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { track } = require('./child-processes');

/**
 * Donde esta el ffmpeg, por orden:
 *  1. COMPACTA_FFMPEG_PATH (diagnostico, o probar el binario de otra plataforma).
 *  2. La app instalada: <recursos>/ffmpeg/. Va fuera del .asar porque un
 *     ejecutable no se puede lanzar desde dentro de el, y se elige por
 *     plataforma Y arquitectura al empaquetar (un Mac Intel y uno Apple
 *     Silicon necesitan binarios distintos).
 *  3. Desarrollo: vendor/ffmpeg/<plataforma>-<arquitectura>/.
 *  4. Desarrollo, sin haber preparado vendor/: el del paquete ffmpeg-static.
 */
function resolveFfmpegPath() {
  if (process.env.COMPACTA_FFMPEG_PATH) return process.env.COMPACTA_FFMPEG_PATH;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'ffmpeg', exe));
  candidates.push(path.join(__dirname, '..', '..', '..', 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`, exe));
  try {
    candidates.push(require('ffmpeg-static'));
  } catch {
    // no instalado: es una dependencia de desarrollo
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

let cachedFfmpegPath;

function getFfmpegPath() {
  if (process.env.COMPACTA_FFMPEG_PATH) return process.env.COMPACTA_FFMPEG_PATH;
  if (cachedFfmpegPath === undefined) {
    cachedFfmpegPath = resolveFfmpegPath();
    // Si al empaquetar se perdio el permiso de ejecucion (puede pasar al
    // copiar entre sistemas de archivos), se restablece; no hace nada si ya lo tiene.
    if (cachedFfmpegPath && process.platform !== 'win32') {
      try {
        fs.chmodSync(cachedFfmpegPath, 0o755);
      } catch {
        // solo lectura (p. ej. una imagen de disco): si ya era ejecutable, basta
      }
    }
  }
  if (!cachedFfmpegPath) throw new Error(t('engine.missing'));
  return cachedFfmpegPath;
}

/**
 * Arquitecturas que lleva un ejecutable de macOS (Mach-O), leyendo solo su cabecera. Un binario "fat" (el que
 * deja `lipo` al juntar Intel y Apple Silicon) las lista todas; uno normal lleva una sola. Devuelve un array de
 * 'x64' / 'arm64' (vacio si no es un Mach-O o no se puede leer). Funcion pura sobre un Buffer: se prueba sin Mac.
 */
function machoArchitectures(head) {
  if (!head || head.length < 8) return [];
  const CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64' };
  const magicBE = head.readUInt32BE(0);
  if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) { // fat (32 o 64 bits de desplazamiento); campos en big-endian
    const count = head.readUInt32BE(4);
    const entrySize = magicBE === 0xcafebabf ? 32 : 20;
    const found = [];
    for (let i = 0; i < Math.min(count, 8); i++) {
      const offset = 8 + i * entrySize;
      if (offset + 4 > head.length) break;
      const arch = CPU[head.readUInt32BE(offset)];
      if (arch) found.push(arch);
    }
    return found;
  }
  const magicLE = head.readUInt32LE(0);
  if (magicLE === 0xfeedfacf) { // Mach-O de 64 bits, una sola arquitectura (cpu en little-endian)
    const arch = CPU[head.readUInt32LE(4)];
    return arch ? [arch] : [];
  }
  return [];
}

function readMachoArchitectures(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(8 + 8 * 32);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return machoArchitectures(head.subarray(0, read));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Version de macOS a partir de la de Darwin (macOS 12 = Darwin 21). NaN si no se entiende. */
function darwinMajor(release) {
  return parseInt(String(release).split('.')[0], 10);
}

/**
 * El ffmpeg de Apple Silicon que se incluye esta compilado para macOS 12 (Monterey) o superior; en un Mac con
 * M1/M2... que se quedo en macOS 11 esa parte no arranca. Como el instalador de Mac es UNO solo (Intel + Apple
 * Silicon juntos), el mismo ffmpeg lleva tambien la parte Intel, y Rosetta 2 (la capa de compatibilidad de Apple,
 * incluida en macOS 11) puede ejecutarla: `arch -x86_64 ffmpeg`. Esta funcion dice si hay que hacerlo.
 */
function needsRosetta({ platform = process.platform, arch = process.arch, release = os.release() } = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') return false;
  const major = darwinMajor(release);
  return Number.isFinite(major) && major < 21;
}

let rosettaProbe; // undefined = sin comprobar

/** ¿Funciona Rosetta en este Mac? Se comprueba una vez ejecutando algo trivial de Apple con `arch -x86_64`. */
function rosettaWorks() {
  if (rosettaProbe === undefined) {
    try {
      const result = spawnSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], { timeout: 15000, stdio: 'ignore' });
      rosettaProbe = result.status === 0;
    } catch {
      rosettaProbe = false;
    }
  }
  return rosettaProbe;
}

/**
 * Como lanzar ffmpeg: { command, args }. Casi siempre es el propio binario; solo en Apple Silicon con macOS 11 se
 * antepone `arch -x86_64` para usar la parte Intel (si el binario la lleva y Rosetta funciona).
 */
function ffmpegLaunch(args, { binary = getFfmpegPath(), rosetta = needsRosetta() && ffmpegCanRunUnderRosetta(binary) } = {}) {
  if (rosetta) return { command: '/usr/bin/arch', args: ['-x86_64', binary, ...args] };
  return { command: binary, args };
}

function ffmpegCanRunUnderRosetta(binary) {
  return readMachoArchitectures(binary).includes('x64') && rosettaWorks();
}

/**
 * Si este Mac NO puede ejecutar el ffmpeg incluido, el texto que explica por que y que hacer (null = sin problema).
 * Se avisa ANTES de lanzarlo, con una salida, en vez de dejar que falle con un error del sistema que nadie
 * entiende. Las fotos y los comprimidos no se ven afectados. Con macOS 11 en Apple Silicon hay dos salidas:
 * Rosetta (si ya esta instalada, se usa sola y no se ve ningun aviso) o actualizar macOS.
 * `canUseRosetta` se inyecta en las pruebas; por defecto se mira en el equipo.
 */
function videoEngineProblem({ platform = process.platform, arch = process.arch, release = os.release(), canUseRosetta } = {}) {
  if (!needsRosetta({ platform, arch, release })) return null;
  const usable = canUseRosetta !== undefined ? canUseRosetta : ffmpegCanRunUnderRosetta(getFfmpegPath());
  return usable ? null : t('engine.macOld');
}

function assertVideoEngineSupported() {
  const problem = videoEngineProblem();
  if (problem) throw new Error(problem);
}

// Codecs de imagen fija: un "video" con uno de estos es una miniatura o una portada, no contenido.
const IMAGE_CODECS = new Set(['mjpeg', 'png', 'bmp', 'gif', 'tiff', 'webp', 'jpeg2000', 'jpegls']);

/**
 * Interpreta lo que ffmpeg escribe al abrir un archivo (`ffmpeg -i`). Es una
 * funcion pura (texto -> datos) a proposito: se prueba sin lanzar procesos.
 */
function parseProbeOutput(text) {
  const info = {
    durationSec: 0,
    hasVideo: false,
    videoCodec: null,
    pixFmt: null,
    width: 0,
    height: 0,
    interlaced: false,
    subtitles: [], // [{ index, codec, language }]
    audio: [], // [{ codec, heavy, sampleRate, channels, bitrateKbps }] heavy = 5.1 / 7.1
    hasCover: false, // portada incrustada (mp3, m4a, flac...): un "video" de un solo fotograma
    extraVideoStreams: 0, // pistas de video REALES ademas de la primera (3D, angulos...): Compacta solo guarda una
    cover: null, // { codec, width, height } de esa portada (para saber si conviene reducirla)
    bitrateKbps: 0 // el global que dice ffmpeg (0 si no lo dice)
  };

  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  if (duration) info.durationSec = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  const overall = /Duration:[^\n]*bitrate:\s*(\d+(?:\.\d+)?)\s*kb\/s/.exec(text);
  if (overall) info.bitrateKbps = Number(overall[1]);

  for (const line of text.split(/\r?\n/)) {
    if (/Stream #\d+:\d+[^:]*:\s*Video:/.test(line) && /attached pic/.test(line)) {
      info.hasCover = true;
      if (!info.cover) {
        const codec = /Video:\s*([A-Za-z0-9_]+)/.exec(line);
        const size = /,\s*(\d{2,5})x(\d{2,5})\b/.exec(line);
        info.cover = { codec: codec ? codec[1].toLowerCase() : null, width: size ? Number(size[1]) : 0, height: size ? Number(size[2]) : 0 };
      }
    }
    const video = /Stream #\d+:\d+[^:]*:\s*Video:\s*([A-Za-z0-9_]+)/.exec(line);
    // Una segunda pista de video de verdad (no una miniatura/portada en formato de imagen) se contaria
    // como contenido que habria que conservar.
    if (video && info.hasVideo && !/attached pic/.test(line) && !IMAGE_CODECS.has(video[1].toLowerCase())) info.extraVideoStreams += 1;
    // Las "portadas" de un mp3/mkv aparecen como un Video de un solo fotograma:
    // no cuentan como video real.
    if (video && !info.hasVideo && !/attached pic/.test(line)) {
      info.hasVideo = true;
      info.videoCodec = video[1].toLowerCase();
      // Formato de pixel y resolucion se buscan por separado: entre ellos
      // ffmpeg mete parentesis con comas, p. ej. "yuv420p10le(tv, bt709/...)",
      // que rompen cualquier patron unico y dejaban los videos de 10 bits
      // (HDR de iPhone) sin reconocer como video.
      const afterCodec = line.slice(line.indexOf('Video:'));
      const pix = /^[^,]*,\s*([a-z][a-z0-9]*)/.exec(afterCodec);
      const size = /,\s*(\d{2,5})x(\d{2,5})\b/.exec(afterCodec);
      info.pixFmt = pix ? pix[1] : null;
      // Camaras, DV y television graban entrelazado ("top first"): si se
      // recodifica como progresivo sin mas, el movimiento se ve peinado.
      info.interlaced = /(?:top|bottom)(?: coded)? first|\binterlaced\b/i.test(afterCodec);
      if (size) {
        info.width = Number(size[1]);
        info.height = Number(size[2]);
      }
      continue;
    }
    const subtitle = /Stream #\d+:(\d+)([^:]*):\s*Subtitle:\s*([A-Za-z0-9_]+)/.exec(line);
    if (subtitle) {
      // El idioma va entre parentesis, p. ej. "(eng)"; no confundirlo con "[0x100]".
      const language = /\(([A-Za-z]{2,3})\)/.exec(subtitle[2]);
      info.subtitles.push({ index: Number(subtitle[1]), codec: subtitle[3].toLowerCase(), language: language ? language[1] : null });
      continue;
    }
    const audio = /Stream #\d+:\d+[^:]*:\s*Audio:\s*([A-Za-z0-9_]+)(.*)/.exec(line);
    if (audio) info.audio.push({ codec: audio[1].toLowerCase(), heavy: /\b(5\.1|7\.1)/.test(audio[2]), ...parseAudioDetails(audio[2]) });
  }
  return info;
}

/** Numero de canales a partir de lo que escribe ffmpeg: mono, stereo, 5.1(side), "3 channels"... */
function channelsFromLayout(text) {
  const named = { mono: 1, stereo: 2, quad: 4, hexagonal: 6, octagonal: 8 };
  const word = /\b(mono|stereo|quad|hexagonal|octagonal)\b/.exec(text);
  if (word) return named[word[1]];
  const count = /\b(\d+) channels?\b/.exec(text);
  if (count) return Number(count[1]);
  const layout = /\b(\d)\.(\d)(?:\.(\d))?\b/.exec(text);
  if (layout) return Number(layout[1]) + Number(layout[2]) + Number(layout[3] || 0);
  return 2;
}

/** Frecuencia, canales y tasa de bits de UNA pista de audio (el resto de la linea de ffmpeg tras el codec). */
function parseAudioDetails(rest) {
  const rate = /(\d{4,6})\s*Hz/.exec(rest);
  const bitrate = /(\d+(?:\.\d+)?)\s*kb\/s/.exec(rest);
  return {
    sampleRate: rate ? Number(rate[1]) : 0,
    channels: channelsFromLayout(rest),
    bitrateKbps: bitrate ? Number(bitrate[1]) : 0
  };
}

/** Abre el archivo con ffmpeg solo para leer sus datos (sale con codigo 1 a proposito: no hay salida). Sirve para video y audio. */
function probeVideo(inputPath) {
  assertVideoEngineSupported();
  return new Promise((resolve, reject) => {
    const launch = ffmpegLaunch(['-hide_banner', '-nostdin', '-i', inputPath]);
    const child = track(spawn(launch.command, launch.args, { windowsHide: true }));
    let output = '';
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(parseProbeOutput(output)));
  });
}

let encoderCache = null;

/**
 * Codificadores que trae ESTE ffmpeg (cada plataforma lleva el suyo: el de Windows, el de
 * Linux y los de Mac no son identicos). Se pregunta una vez; el audio elige con esto y
 * nunca depende de que un codificador concreto exista.
 */
function listEncoders() {
  if (encoderCache) return encoderCache;
  encoderCache = new Promise((resolve) => {
    let output = '';
    let child;
    try {
      const launch = ffmpegLaunch(['-hide_banner', '-nostdin', '-encoders']);
      child = track(spawn(launch.command, launch.args, { windowsHide: true }));
    } catch {
      resolve(new Set());
      return;
    }
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', () => resolve(new Set()));
    child.on('close', () => {
      const names = new Set();
      for (const line of output.split(/\r?\n/)) {
        const match = /^\s[A-Z.]{6}\s(\S+)/.exec(line);
        if (match) names.add(match[1]);
      }
      resolve(names);
    });
  });
  return encoderCache;
}

/** Baja la prioridad del proceso para que la interfaz y el resto del equipo sigan fluidos. */
function lowerPriority(child) {
  try {
    os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // No es critico: en algunos sistemas no se permite cambiarla.
  }
}

/**
 * Ejecuta ffmpeg con `args`. `onProgress(0..1)` se llama mientras codifica (si
 * se conoce la duracion). Rechaza con el ultimo mensaje de error de ffmpeg si
 * termina mal. Lleva `-progress pipe:1`, que da el avance en un formato
 * estable y facil de leer, sin tener que analizar la salida de texto normal.
 */
function runFfmpeg(args, { durationSec = 0, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    // stats_period: avance cada 0,25 s (por defecto cada 0,5 s: un video
    // corto acabaria sin haber mostrado ningun porcentaje intermedio).
    const fullArgs = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-nostats', '-stats_period', '0.25', '-progress', 'pipe:1', ...args];
    const launch = ffmpegLaunch(fullArgs);
    const child = track(spawn(launch.command, launch.args, { windowsHide: true }));
    lowerPriority(child);

    let errorText = '';
    let pending = '';
    child.stderr.on('data', (chunk) => { errorText = (errorText + chunk).slice(-2000); });
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        // out_time_us / out_time_ms: ambos vienen en microsegundos (asi lo
        // documenta ffmpeg, aunque el segundo se llame "ms").
        const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (match && onProgress && durationSec > 0) {
          onProgress(Math.min(1, Number(match[1]) / 1e6 / durationSec));
        }
      }
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? 'La codificacion del video se interrumpio.' : (errorText.trim().split('\n').pop() || `ffmpeg termino con codigo ${code}`)));
    });
  });
}

/**
 * Ejecuta ffmpeg y devuelve TODO lo que escribe por la salida estandar (un Buffer). Sirve para
 * leer audio decodificado (analisis) o para medir el peso de una codificacion de prueba sin crear
 * archivos. Rechaza si ffmpeg termina mal.
 */
function captureFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const launch = ffmpegLaunch(['-hide_banner', '-nostdin', '-loglevel', 'error', ...args]);
    const child = track(spawn(launch.command, launch.args, { windowsHide: true }));
    lowerPriority(child);
    const chunks = [];
    let errorText = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { errorText = (errorText + chunk).slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(errorText.trim().split('\n').pop() || `ffmpeg termino con codigo ${code}`));
    });
  });
}

module.exports = { getFfmpegPath, ffmpegLaunch, machoArchitectures, needsRosetta, videoEngineProblem, parseProbeOutput, probeVideo, runFfmpeg, listEncoders, captureFfmpeg };
