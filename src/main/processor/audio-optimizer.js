const { t } = require('../../shared/i18n');
const fs = require('fs/promises');
const path = require('path');
const { withExtension, buildReport, tempPathFor, renameWithRetry, copyOriginal, chooseOutputPath } = require('./output-files');
const { probeVideo, runFfmpeg, listEncoders } = require('./ffmpeg');
const { analyzeChannels, estimateKbps } = require('./audio-analysis');

/**
 * Compresion de AUDIO con la misma filosofia que fotos y videos: la barra de
 * calidad, el "modo agresivo" y la "compresion maxima" de Ajustes se traducen a
 * parametros de ffmpeg, y el resultado nunca es peor que el original.
 *
 * Donde se gana peso SIN perder nada que se oiga (en este orden de importancia):
 *  1. Lo sin perdida (WAV, AIFF, FLAC, ALAC...) se recodifica a MP3 de calidad variable
 *     transparente: -85 % o mas. Con la opcion "Sin perdida (FLAC)" va a FLAC: -40 a -55 %
 *     y bit a bit identico.
 *  2. ESTEREO QUE ES MONO: muchas grabaciones (voz, Zoom, micros USB) llevan el mismo sonido en
 *     los dos canales, o un canal vacio. Se mide (audio-analysis.js) y se guardan en mono:
 *     la mitad de bits sin cambiar nada de lo que se oye. En musica el criterio es estricto.
 *  3. MODO VOZ (eleccion de la persona, p. ej. en un perfil "Predicaciones"): una voz necesita
 *     3-4 veces menos que una orquesta. Mono (si los canales se parecen) y MP3 de calidad
 *     variable mas baja: medido con PESQ en voz real, ~40-70 kbps contra ~110 y casi sin diferencia.
 *     NO se adivina solo: separar voz de musica por energia da falsos positivos (batería y piano
 *     suave salen como "voz") y degradaria musica. Solo los codecs que son SOLO de voz (AMR, GSM,
 *     Speex...) se tratan como voz automaticamente.
 *  4. PORTADAS: una portada de 1400-3000 px puede pesar mas que la cancion. Se reduce a 600 px JPEG;
 *     si el audio ya era optimo, se copia SIN recodificar (cero perdida) y solo se cambia la portada.
 *  5. Lo que ya viene con perdida se recodifica SOLO si una prueba real de codificacion
 *     (no una tabla) demuestra que el resultado pesara un 20 % menos o mas. Recodificar con perdida
 *     acumula degradacion: por menos ahorro que eso no compensa.
 *
 * Que se hace para NO perder calidad audible:
 *  - Se decide por el CODEC real del archivo, no por su extension. Asi un .caf de
 *    Mac, un .3gp de voz, un .mp4 sin imagen o un .webm de solo audio funcionan
 *    igual que un .mp3 o un .wav.
 *  - Formato "Compatible" (por defecto): MP3 (lo reproduce TODO: moviles, coches, equipos
 *    de sonido de iglesias, USB). Con mas de 2 canales (5.1) va a AAC, que si los admite.
 *    Se mantiene la misma familia (MP3 -> MP3, M4A -> M4A, OGG -> OGG, OPUS -> OPUS);
 *    los de otras (WMA, AC3, DTS...) pasan a MP3.
 *  - Formato "Maxima eficiencia": Opus (a igual calidad pesa ~35 % menos que MP3; necesita un
 *    reproductor moderno y no guarda la portada).
 *  - Nunca se sube de frecuencia ni de canales; mas de 48 kHz se baja (inaudible).
 *  - Se conservan etiquetas (titulo, artista...), portada y capitulos (audiolibros .m4b).
 *  - Con varias pistas de audio (MKA) se guardan todas en un MKA.
 *  - Si el resultado no ahorra al menos un 5 %, se deja el original intacto.
 */

const MIN_SAVING_RATIO = 0.05;
// Un audio CON PERDIDA solo se recodifica si la salida medida pesa al menos esto menos que el origen.
const RECODE_MIN_SAVING = 0.2;
// Cuanto puede pesar el canal lateral (L-R) frente al central (L+R) para tratarlo como mono, en dB.
// Musica: muy estricto (-32 dB = los dos canales difieren un 2,5 %: indistinguible). Voz: mas relajado.
const MONO_MAX_SIDE_DB = -32;
const VOICE_MONO_MAX_SIDE_DB = -15;
// Portadas: mas grandes que esto (o en un formato pesado como PNG/BMP) se reducen.
const COVER_MAX_PX = 800;
const COVER_TARGET_PX = 600;
const HEAVY_COVER_CODECS = new Set(['png', 'bmp', 'gif', 'tiff', 'webp']);

const LOSSLESS_CODECS = new Set([
  'flac', 'alac', 'wavpack', 'ape', 'tta', 'tak', 'truehd', 'mlp', 'shorten', 'mp4als', 'wmalossless',
  'dsd_lsbf', 'dsd_msbf', 'dsd_lsbf_planar', 'dsd_msbf_planar'
]);
// Formatos que existen SOLO para voz (telefonia, grabadoras): se tratan como voz sin preguntar.
const VOICE_CODECS = new Set(['amr_nb', 'amr_wb', 'gsm', 'gsm_ms', 'speex', 'ilbc', 'g723_1', 'g729', 'ra_144', 'ra_288', 'codec2']);
// El DSD (2,8 MHz) no cabe en FLAC.
const DSD_CODECS = new Set(['dsd_lsbf', 'dsd_msbf', 'dsd_lsbf_planar', 'dsd_msbf_planar']);
const FLOAT_PCM = /^pcm_f(32|64)/;
const MP3_RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);
// Contenedores M4A (los que admiten portada y capitulos con el muxer "ipod").
const M4_EXTENSIONS = new Set(['.m4a', '.m4b', '.m4r']);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Calidad de la barra (60-100, como fotos y videos); "agresivo" resta 15 puntos. */
function effectiveQuality(quality, aggressive) {
  const q = clamp(Number.isFinite(Number(quality)) ? Number(quality) : 90, 1, 100);
  return aggressive ? clamp(q - 15, 40, 100) : q;
}

/** Familia de salida segun el codec de origen (ver el comentario del principio). */
function chooseFamily(codec, channels) {
  if (channels > 2) return 'aac'; // MP3 no admite mas de 2 canales
  if (codec === 'mp3' || codec === 'mp2' || codec === 'mp1') return 'mp3';
  if (codec === 'aac') return 'aac';
  if (codec === 'vorbis') return 'vorbis';
  if (codec === 'opus') return 'opus';
  return 'mp3';
}

const isLossless = (codec) => codec.startsWith('pcm_') || LOSSLESS_CODECS.has(codec);

// ----- Calidad -> parametros de cada codificador (funciones puras) -----

/** Escala por canales: mono necesita bastante menos que estereo; 5.1 bastante mas. */
function channelScale(channels) {
  if (channels <= 1) return 0.6;
  if (channels === 2) return 1;
  return 1 + (channels - 2) * 0.25;
}

/** AAC: 90 -> 192 kbps estereo (transparente), 100 -> 256, 75 -> 144. */
function aacKbps(effective, channels) {
  const stereo = effective <= 90 ? 96 + (effective - 60) * 3.2 : 192 + (effective - 90) * 6.4;
  return Math.round(clamp(stereo, 64, 320) * channelScale(channels) / 8) * 8;
}

/** LAME VBR: V2 (~190 kbps, transparente) con la calidad por defecto; V0 al maximo. */
function mp3VbrLevel(effective) {
  if (effective >= 98) return 0;
  if (effective >= 94) return 1;
  if (effective >= 88) return 2;
  if (effective >= 82) return 3;
  if (effective >= 76) return 4;
  if (effective >= 70) return 5;
  if (effective >= 64) return 6;
  return 7;
}
const MP3_VBR_KBPS = [245, 225, 190, 175, 165, 130, 115, 100];

/**
 * VOZ en MP3. Calibrado midiendo voz real (PESQ-WB, maximo 4,64): V4 mono = 4,62 en una predicacion
 * de estudio y 4,46 en voz limpia de alta fidelidad; V2 = casi identico al original.
 * 90 -> V4 (la opcion por defecto), 100 -> V2, 60 -> V8.
 */
function mp3VoiceLevel(effective) {
  if (effective >= 98) return 2;
  if (effective >= 94) return 3;
  if (effective >= 86) return 4;
  if (effective >= 80) return 5;
  if (effective >= 72) return 6;
  if (effective >= 64) return 7;
  return 8;
}
// kbps aproximados en MONO por nivel V (medidos con voz real); el estereo pesa ~1,5 veces mas.
const MP3_VOICE_KBPS = { 2: 82, 3: 76, 4: 66, 5: 58, 6: 48, 7: 40, 8: 34 };

/** Con calidad 80 o menos, la voz se guarda a 22,05 kHz (la voz casi no tiene nada por encima de 10 kHz). */
const VOICE_LOW_RATE_MAX_QUALITY = 80;

/** Opus: 90 -> 128 kbps estereo (transparente), 100 -> 192, 60 -> 64. */
function opusKbps(effective, channels) {
  const stereo = effective <= 90 ? 64 + (effective - 60) * (64 / 30) : 128 + (effective - 90) * 6.4;
  return Math.round(clamp(stereo, 48, 256) * channelScale(channels));
}

/** Opus para voz: 90 -> 32 kbps mono, 100 -> 48, 75 -> 24, 60 -> 20. */
function opusVoiceKbps(effective, channels) {
  const mono = effective >= 90 ? 32 + (effective - 90) * 1.6 : 20 + (effective - 60) * (12 / 30);
  return Math.round(clamp(mono, 20, 48) * (channels >= 2 ? 1.6 : 1));
}

/** AAC para voz: 90 -> 64 kbps mono, 100 -> 96, 75 -> 48. */
function aacVoiceKbps(effective, channels) {
  const mono = effective >= 90 ? 64 + (effective - 90) * 3.2 : 40 + (effective - 60) * 0.8;
  return Math.round(clamp(mono, 40, 96) * (channels >= 2 ? 1.6 : 1) / 8) * 8;
}

/** Vorbis: 90 -> q5,25 (~165 kbps), 100 -> q6, 60 -> q3. */
function vorbisQuality(effective) {
  return Math.round(clamp(3 + (effective - 60) * 0.075, 2, 6) * 100) / 100;
}

/** Vorbis para voz: 90 -> q2,5, 60 -> q0,5. */
function vorbisVoiceQuality(effective) {
  return Math.round(clamp(0.5 + (effective - 60) * 0.066, 0, 4) * 100) / 100;
}

/** Tasa de bits aproximada de lo que se va a generar (una tabla: solo se usa si no se pudo medir). */
function expectedKbps(family, effective, channels, voice = false) {
  if (voice) {
    if (family === 'mp3') return Math.round(MP3_VOICE_KBPS[mp3VoiceLevel(effective)] * (channels >= 2 ? 1.5 : 1));
    if (family === 'opus') return opusVoiceKbps(effective, channels);
    if (family === 'vorbis') return Math.round((64 + 32 * vorbisVoiceQuality(effective)) * (channels <= 1 ? 0.6 : 1));
    return aacVoiceKbps(effective, channels);
  }
  if (family === 'mp3') return Math.round(MP3_VBR_KBPS[mp3VbrLevel(effective)] * (channels <= 1 ? 0.55 : 1));
  if (family === 'opus') return opusKbps(effective, channels);
  if (family === 'vorbis') return Math.round(32 * vorbisQuality(effective) * (channels <= 1 ? 0.6 : 1));
  return aacKbps(effective, channels);
}

/** Frecuencia de salida: null = la misma. Nunca se sube; mas de 48 kHz se baja; MP3 solo admite unas concretas. */
function outputSampleRate(family, rate) {
  if (!(rate > 0)) return null;
  if (rate > 48000) return rate % 44100 === 0 ? 44100 : 48000;
  if (family === 'mp3' && !MP3_RATES.has(rate)) return 44100;
  return null;
}

/** Tasa de bits del ORIGEN: la de la pista, la global o, si ffmpeg no la dice, peso / duracion. */
function sourceKbps(probe, originalBytes) {
  const track = probe.audio[0];
  if (track && track.bitrateKbps > 0) return track.bitrateKbps;
  if (probe.bitrateKbps > 0) return probe.bitrateKbps;
  if (probe.durationSec > 0) return (originalBytes * 8) / 1000 / probe.durationSec;
  return 0;
}

/** ¿La portada pesa de mas? Grande (en pixeles) o en un formato pesado (PNG, BMP...). Funcion pura. */
function coverNeedsShrink(cover) {
  if (!cover) return false;
  if (HEAVY_COVER_CODECS.has(cover.codec)) return true;
  return cover.width > COVER_MAX_PX || cover.height > COVER_MAX_PX;
}

/** Argumentos de ffmpeg para dejar la portada en 600 px JPEG (o copiarla tal cual si ya es ligera). */
function coverArgs(cover) {
  if (!coverNeedsShrink(cover)) return ['-c:v', 'copy'];
  // OJO: no usar `-frames:v 1` aqui: ffmpeg deja de escribir en cuanto sale ese fotograma y el audio se pierde.
  return ['-c:v', 'mjpeg', '-q:v', '4',
    '-vf', `scale='min(${COVER_TARGET_PX},iw)':'min(${COVER_TARGET_PX},ih)':force_original_aspect_ratio=decrease,format=yuvj420p`];
}

/**
 * Decide TODO lo que se hara con este audio: o se deja intacto (`skip`) o se recodifica con
 * un codificador concreto, en un contenedor concreto. Funcion pura (datos -> plan).
 *  - `encoders`: nombres de codificadores de este ffmpeg (si no se pasa, se supone que estan todos).
 *  - `analysis`: mediciones opcionales. `channelMode` ('stereo' | 'mix' | 'left' | 'right', ver
 *    audio-analysis.js) y `projectedKbps` (lo que pesaria la salida segun una prueba real).
 * El plan siempre trae todos los campos aunque `skip` este puesto: sirve para la prueba de peso
 * y para el caso de "copiar el audio y solo reducir la portada".
 */
function planAudio(probe, options, inputPath, originalBytes, encoders, analysis = {}) {
  const track = probe.audio[0];
  const codec = track.codec;
  const channels = Math.max(1, track.channels || 2);
  const effective = effectiveQuality(options.quality, !!options.aggressive);
  const has = (name) => !encoders || encoders.has(name);
  const multiTrack = probe.audio.length > 1;
  const ownExt = path.extname(inputPath).toLowerCase();
  const lossless = isLossless(codec);
  const voice = options.audioKind === 'voice' || VOICE_CODECS.has(codec);
  const wantFormat = options.audioFormat === 'opus' || options.audioFormat === 'flac' ? options.audioFormat : 'compat';

  // ----- Sin perdida a FLAC (opcion de Ajustes): bit a bit identico, sin tocar canales ni frecuencia -----
  if (lossless && wantFormat === 'flac' && !multiTrack && channels <= 8 && !DSD_CODECS.has(codec) && has('flac')) {
    const same = codec === 'flac';
    return {
      skip: same ? 'ya-optimizado' : null,
      family: 'flac', codec, extension: '.flac', format: 'flac', channels, effective, voice: false,
      channelMode: 'stereo', outChannels: channels, sampleRate: null, multiTrack: false, lossless: true,
      targetKbps: 0, keepsCover: probe.hasCover, cover: probe.cover, wantsChannelAnalysis: false,
      sampleFormat24: FLOAT_PCM.test(codec) || codec === 'pcm_s32le' || codec === 'pcm_s32be',
      maxCompression: options.maxCompression === true
    };
  }

  let family = chooseFamily(codec, channels);
  if (wantFormat === 'opus' && channels <= 2) family = 'opus';
  // Cada plataforma lleva su ffmpeg: si falta el codificador preferido se usa AAC, que siempre esta.
  const needed = { mp3: 'libmp3lame', opus: 'libopus', vorbis: 'libvorbis', aac: 'aac' };
  if (!has(needed[family])) family = 'aac';

  // Estereo que en realidad es mono (ver audio-analysis.js). Con varias pistas no se toca.
  const channelMode = channels === 2 && !multiTrack && analysis.channelMode ? analysis.channelMode : 'stereo';
  const outChannels = channelMode === 'stereo' ? channels : 1;

  const targetKbps = expectedKbps(family, effective, outChannels, voice);
  let skip = null;
  if (!lossless) {
    const source = sourceKbps(probe, originalBytes);
    // Si hay una prueba real de codificacion se usa; si no, la tabla.
    const projected = analysis.projectedKbps > 0 ? analysis.projectedKbps : targetKbps;
    if (source > 0 && projected > source * (1 - RECODE_MIN_SAVING)) skip = 'ya-optimizado';
  }

  let extension;
  let format;
  if (multiTrack) {
    extension = '.mka';
    format = 'matroska';
  } else if (family === 'mp3') {
    extension = '.mp3';
    format = 'mp3';
  } else if (family === 'aac') {
    extension = M4_EXTENSIONS.has(ownExt) ? ownExt : '.m4a';
    format = 'ipod';
  } else if (family === 'vorbis') {
    extension = '.ogg';
    format = 'ogg';
  } else {
    extension = '.opus';
    format = 'opus';
  }

  let sampleRate = outputSampleRate(family, track.sampleRate);
  if (voice && family === 'mp3' && effective <= VOICE_LOW_RATE_MAX_QUALITY && track.sampleRate > 22050) sampleRate = 22050;

  // La portada solo cabe en MP3 y M4A (no en OGG/OPUS ni en MKA con este metodo).
  const keepsCover = probe.hasCover && !multiTrack && (family === 'mp3' || family === 'aac');
  return {
    skip,
    family,
    codec,
    extension,
    format,
    channels,
    outChannels,
    channelMode,
    effective,
    voice,
    lossless,
    targetKbps,
    sampleRate,
    multiTrack,
    keepsCover,
    cover: probe.cover,
    wantsChannelAnalysis: channels === 2 && !multiTrack,
    maxCompression: options.maxCompression === true
  };
}

/** Filtro de audio que deja el estereo en mono segun lo medido ('' si no hay que tocar los canales). */
function channelFilter(mode) {
  if (mode === 'mix') return 'pan=mono|c0=0.5*c0+0.5*c1';
  if (mode === 'left') return 'pan=mono|c0=c0';
  if (mode === 'right') return 'pan=mono|c0=c1';
  return '';
}

/** Parte de los argumentos que es solo del CODIFICADOR de audio (la comparten el archivo real y la prueba de peso). */
function codecArgs(plan, { inlineFilter = false } = {}) {
  const args = [];
  // `inlineFilter`: el filtro de canales ya va dentro del grafo complejo (prueba de peso con varios trozos).
  const filter = channelFilter(plan.channelMode);
  if (filter && !inlineFilter) args.push('-af', filter);

  if (plan.family === 'flac') {
    args.push('-c:a', 'flac', '-compression_level', plan.maxCompression ? '12' : '8');
    if (plan.sampleFormat24) args.push('-sample_fmt', 's32', '-bits_per_raw_sample', '24');
  } else if (plan.family === 'mp3') {
    const level = plan.voice ? mp3VoiceLevel(plan.effective) : mp3VbrLevel(plan.effective);
    args.push('-c:a', 'libmp3lame', '-q:a', String(level), '-compression_level', plan.maxCompression ? '0' : '3');
  } else if (plan.family === 'aac') {
    const kbps = plan.voice ? aacVoiceKbps(plan.effective, plan.outChannels) : aacKbps(plan.effective, plan.outChannels);
    args.push('-c:a', 'aac', '-b:a', `${kbps}k`);
  } else if (plan.family === 'vorbis') {
    args.push('-c:a', 'libvorbis', '-q:a', String(plan.voice ? vorbisVoiceQuality(plan.effective) : vorbisQuality(plan.effective)));
  } else {
    const kbps = plan.voice ? opusVoiceKbps(plan.effective, plan.outChannels) : opusKbps(plan.effective, plan.outChannels);
    args.push('-c:a', 'libopus', '-b:a', `${kbps}k`, '-vbr', 'on', '-application', plan.voice ? 'voip' : 'audio');
  }
  if (plan.sampleRate) args.push('-ar', String(plan.sampleRate));
  return args;
}

/** Argumentos de ffmpeg para un plan. Funcion pura: se prueba sin ejecutar nada. */
function buildAudioArgs(plan, inputPath, outputPath, { withCover = true } = {}) {
  const args = ['-i', inputPath, '-map', plan.multiTrack ? '0:a' : '0:a:0'];
  if (plan.keepsCover && withCover) args.push('-map', '0:v:0', ...coverArgs(plan.cover), '-disposition:v', 'attached_pic');
  args.push('-map_metadata', '0', '-map_chapters', '0');
  args.push(...codecArgs(plan));
  if (plan.family === 'mp3') args.push('-id3v2_version', '3');
  if (plan.format === 'ipod') args.push('-movflags', '+faststart');
  args.push('-f', plan.format, outputPath);
  return args;
}

/**
 * Argumentos de la codificacion de PRUEBA (a un pipe, solo para medir cuanto pesa). `windows` es un trozo
 * ({ start, length }) o varios: con varios, UN solo ffmpeg los lee y los junta (`concat`) en vez de lanzar un
 * proceso por trozo. Es solo una MEDIDA: el algoritmo de LAME mas rapido (-q 5) tarda la mitad y da un tamano
 * apenas mayor (conservador).
 */
function buildTrialArgs(plan, inputPath, windows) {
  const list = [].concat(windows);
  const fast = plan.family === 'mp3' ? ['-compression_level', '5'] : [];
  const inputs = list.flatMap((window) => ['-ss', String(window.start), '-t', String(window.length), '-i', inputPath]);
  if (list.length === 1) return [...inputs, '-map', '0:a:0', '-vn', ...codecArgs(plan), ...fast, '-f', plan.format, 'pipe:1'];
  const chain = channelFilter(plan.channelMode);
  const graph = `${list.map((_, i) => `[${i}:a:0]`).join('')}concat=n=${list.length}:v=0:a=1${chain ? `,${chain}` : ''}[out]`;
  return [...inputs, '-filter_complex', graph, '-map', '[out]', ...codecArgs(plan, { inlineFilter: true }), ...fast, '-f', plan.format, 'pipe:1'];
}

// El MP3/Vorbis de calidad variable puede pesar bastante menos que la tabla si el sonido es facil (una voz
// limpia a V2: ~58 % de la tabla). Mas optimista que eso no se ha visto: si ni asi llegaria al ahorro minimo,
// la prueba de peso no puede cambiar la decision y se evita (lanzar un ffmpeg cuesta, sobre todo en Windows).
const TRIAL_OPTIMISM = 0.55;

/** ¿Merece la pena la prueba de peso? Funcion pura. */
function trialCanChangeDecision(plan, probe, originalBytes) {
  const source = sourceKbps(probe, originalBytes);
  return !(source > 0) || plan.targetKbps * TRIAL_OPTIMISM <= source * (1 - RECODE_MIN_SAVING);
}

/**
 * Cuando el audio ya es optimo pero lleva una portada pesada: se COPIA el audio sin recodificar (cero
 * perdida) y solo se cambia la portada. Solo para los contenedores donde eso es seguro; null si no aplica.
 */
function planCoverOnly(probe, inputPath) {
  if (!probe.hasCover || !coverNeedsShrink(probe.cover) || probe.audio.length !== 1) return null;
  const codec = probe.audio[0].codec;
  const ext = path.extname(inputPath).toLowerCase();
  if (codec === 'mp3' && ext === '.mp3') return { extension: '.mp3', format: 'mp3', cover: probe.cover };
  if (codec === 'aac' && M4_EXTENSIONS.has(ext)) return { extension: ext, format: 'ipod', cover: probe.cover };
  if (codec === 'flac' && ext === '.flac') return { extension: '.flac', format: 'flac', cover: probe.cover };
  return null;
}

function buildCoverOnlyArgs(plan, inputPath, outputPath) {
  const args = ['-i', inputPath, '-map', '0:a:0', '-map', '0:v:0', '-c:a', 'copy', ...coverArgs(plan.cover),
    '-disposition:v', 'attached_pic', '-map_metadata', '0', '-map_chapters', '0'];
  if (plan.format === 'mp3') args.push('-id3v2_version', '3');
  if (plan.format === 'ipod') args.push('-movflags', '+faststart');
  args.push('-f', plan.format, outputPath);
  return args;
}

/**
 * Comprueba que lo recien escrito es un audio completo: se abre, tiene audio y dura lo mismo que el
 * original (un margen de 1,5 s o 3 %). Es la red de seguridad contra una salida truncada o vacia que
 * ffmpeg diera por buena: antes de reemplazar nada, se comprueba que no falta musica.
 */
async function isCompleteOutput(filePath, expectedSec) {
  try {
    const out = await probeVideo(filePath);
    if (out.audio.length === 0) return false;
    if (!(expectedSec > 0) || !(out.durationSec > 0)) return true;
    return Math.abs(out.durationSec - expectedSec) <= Math.max(1.5, expectedSec * 0.03);
  } catch {
    return false;
  }
}

/** Texto corto de lo que se hizo, para mostrarlo junto al resultado. */
function describePlan(plan) {
  const parts = [];
  if (plan.voice) parts.push(t('detail.voice'));
  if (plan.channelMode !== 'stereo') parts.push(t('detail.mono'));
  if (plan.family === 'flac') parts.push(t('detail.lossless'));
  return parts.join(' · ');
}

/**
 * Comprime un audio (o cualquier archivo con audio y sin imagen). `probe` es opcional: si el
 * llamador ya lo analizo (el compresor de video lo hace) no se vuelve a abrir el archivo.
 * Escribe de forma atomica y, si no ahorra lo suficiente, deja el original sin tocar.
 */
async function optimizeAudio(inputPath, requestedOutputPath, options = {}, onProgress, knownProbe) {
  const outputPath = await chooseOutputPath(inputPath, requestedOutputPath);
  const originalBytes = (await fs.stat(inputPath)).size;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const probe = knownProbe || await probeVideo(inputPath);
  if (probe.audio.length === 0) throw new Error(t('media.badAudio'));

  const encoders = await listEncoders();
  let plan = planAudio(probe, options, inputPath, originalBytes, encoders);

  // Mediciones sobre unas muestras (una fraccion de segundo): canales reales y peso real de la salida.
  const analysis = {};
  if (plan.wantsChannelAnalysis) {
    const maxSideDb = plan.voice ? VOICE_MONO_MAX_SIDE_DB : MONO_MAX_SIDE_DB;
    analysis.channelMode = (await analyzeChannels(inputPath, probe.durationSec, maxSideDb)).mode;
    plan = planAudio(probe, options, inputPath, originalBytes, encoders, analysis);
  }
  if (!plan.lossless && (plan.family === 'mp3' || plan.family === 'vorbis') && trialCanChangeDecision(plan, probe, originalBytes)) {
    const projected = await estimateKbps((windows) => buildTrialArgs(plan, inputPath, windows), probe.durationSec);
    if (projected) {
      analysis.projectedKbps = projected;
      plan = planAudio(probe, options, inputPath, originalBytes, encoders, analysis);
    }
  }

  if (plan.skip) {
    const coverOnly = planCoverOnly(probe, inputPath);
    if (coverOnly) {
      const result = await rewriteCover(coverOnly, inputPath, outputPath, originalBytes, probe, onProgress);
      if (result) return result;
    }
    await copyOriginal(inputPath, outputPath);
    return buildReport(inputPath, outputPath, originalBytes, originalBytes, true, plan.skip);
  }

  const finalPath = withExtension(outputPath, plan.extension);
  const tmpPath = tempPathFor(finalPath);
  const run = (withCover) => runFfmpeg(buildAudioArgs(plan, inputPath, tmpPath, { withCover }), { durationSec: probe.durationSec, onProgress });
  try {
    try {
      await run(true);
    } catch (err) {
      // Una portada en un formato raro (BMP, GIF...) puede no caber en el MP3/M4A: el audio
      // importa mas que la imagen, asi que se reintenta sin ella en vez de fallar.
      if (!(plan.keepsCover && probe.hasCover)) throw err;
      await fs.unlink(tmpPath).catch(() => {});
      await run(false);
    }
    const newBytes = (await fs.stat(tmpPath)).size;

    if (newBytes > originalBytes * (1 - MIN_SAVING_RATIO) || !(await isCompleteOutput(tmpPath, probe.durationSec))) {
      await fs.unlink(tmpPath).catch(() => {});
      await copyOriginal(inputPath, outputPath);
      return buildReport(inputPath, outputPath, originalBytes, originalBytes, true, 'sin-mejora-posible');
    }

    await renameWithRetry(tmpPath, finalPath);
    return { ...buildReport(inputPath, finalPath, originalBytes, newBytes, false, null), detail: describePlan(plan) };
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Copia el audio tal cual y reduce solo la portada. null si no ahorra lo suficiente (se usara el original). */
async function rewriteCover(coverOnly, inputPath, outputPath, originalBytes, probe, onProgress) {
  const finalPath = withExtension(outputPath, coverOnly.extension);
  const tmpPath = tempPathFor(finalPath);
  try {
    await runFfmpeg(buildCoverOnlyArgs(coverOnly, inputPath, tmpPath), { durationSec: probe.durationSec, onProgress });
    const newBytes = (await fs.stat(tmpPath)).size;
    if (newBytes > originalBytes * (1 - MIN_SAVING_RATIO) || !(await isCompleteOutput(tmpPath, probe.durationSec))) {
      await fs.unlink(tmpPath).catch(() => {});
      return null;
    }
    await renameWithRetry(tmpPath, finalPath);
    return { ...buildReport(inputPath, finalPath, originalBytes, newBytes, false, null), detail: t('detail.cover') };
  } catch {
    // El audio importa mas que la portada: ante cualquier fallo, se deja el original.
    await fs.unlink(tmpPath).catch(() => {});
    return null;
  }
}

module.exports = {
  optimizeAudio,
  planAudio,
  buildAudioArgs,
  buildTrialArgs,
  trialCanChangeDecision,
  planCoverOnly,
  isCompleteOutput,
  buildCoverOnlyArgs,
  coverNeedsShrink,
  chooseFamily,
  effectiveQuality,
  aacKbps,
  mp3VbrLevel,
  mp3VoiceLevel,
  opusKbps,
  vorbisQuality,
  expectedKbps,
  outputSampleRate
};
