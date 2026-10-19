'use strict';

// Genera audios de prueba REALES con el propio ffmpeg del proyecto (sin archivos
// binarios en el repositorio), en todos los formatos que la app acepta como entrada.
// Se usa una mezcla de tonos y un poco de ruido: pesa lo bastante como para que haya
// margen de compresion y no es un tono puro (que cualquier codec reduce a nada).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getFfmpegPath } = require('../../src/main/processor/ffmpeg');

function run(args) {
  const r = spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg fallo al preparar la prueba (${args.join(' ')}): ${r.stderr}`);
}

function source(seconds, rate, channels, dualMono = false) {
  // Cada canal lleva un sonido DISTINTO (frecuencias y ruido propios): es estereo de verdad. Con
  // `dualMono` todos llevan exactamente lo mismo, como una grabacion de voz guardada en estereo.
  const expr = (c) => `0.30*sin(2*PI*(440+9*${c})*t)+0.15*sin(2*PI*(1320+11*${c})*t)+0.08*sin(2*PI*3100*t*(1+0.1*sin(t+${c})))+0.05*(random(${c})-0.5)`;
  const layout = channels === 1 ? 'mono' : channels === 2 ? 'stereo' : channels === 6 ? '5.1' : `${channels}c`;
  const exprs = Array.from({ length: channels }, (_, c) => expr(dualMono ? 0 : c));
  return ['-f', 'lavfi', '-i', `aevalsrc=${exprs.join('|')}:s=${rate}:d=${seconds}:c=${layout}`];
}

/**
 * opts: { seconds, rate, channels, dualMono, codecArgs: [...], tags: {titulo: 'x'}, cover: true }
 * `codecArgs` decide el formato (p. ej. ['-c:a', 'libmp3lame', '-b:a', '320k']).
 */
function makeAudio(outputPath, opts = {}) {
  const { seconds = 4, rate = 44100, channels = 2, codecArgs = [], tags = {}, cover = false, extra = [], dualMono = false } = opts;
  const args = [...source(seconds, rate, channels, dualMono)];
  let coverPath = null;
  if (cover) {
    coverPath = `${outputPath}.cover.jpg`;
    run(['-f', 'lavfi', '-i', 'testsrc2=size=300x300:rate=1:duration=1', '-frames:v', '1', coverPath]);
    args.push('-i', coverPath, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic');
  }
  args.push(...codecArgs);
  for (const [key, value] of Object.entries(tags)) args.push('-metadata', `${key}=${value}`);
  args.push(...extra, outputPath);
  run(args);
  if (coverPath) fs.rmSync(coverPath, { force: true });
}

/** Un m4b con capitulos (audiolibro). */
function makeAudiobook(outputPath) {
  const meta = `${outputPath}.ffmeta`;
  fs.writeFileSync(meta, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=Capitulo uno\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=4000\ntitle=Capitulo dos\n');
  run([...source(4, 44100, 2), '-i', meta, '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1', '-c:a', 'aac', '-b:a', '320k', outputPath]);
  fs.rmSync(meta, { force: true });
}

/** Un MKA con dos pistas de audio. */
function makeTwoTrackMka(outputPath) {
  run([...source(3, 44100, 2), ...source(3, 44100, 1), '-map', '0:a', '-map', '1:a', '-c:a:0', 'flac', '-c:a:1', 'flac', outputPath]);
}

/** Cada formato de entrada: nombre de archivo, como generarlo y que se espera. */
const FORMATS = [
  { file: 'a.wav', codecArgs: ['-c:a', 'pcm_s16le'], ext: '.mp3', saves: true },
  { file: 'a24.wav', codecArgs: ['-c:a', 'pcm_s24le'], ext: '.mp3', saves: true },
  { file: 'a.wave', codecArgs: ['-c:a', 'pcm_s16le', '-f', 'wav'], ext: '.mp3', saves: true },
  { file: 'a.w64', codecArgs: ['-c:a', 'pcm_s16le'], ext: '.mp3', saves: true },
  { file: 'a.aiff', codecArgs: ['-c:a', 'pcm_s16be'], ext: '.mp3', saves: true },
  { file: 'a.aif', codecArgs: ['-c:a', 'pcm_s16be', '-f', 'aiff'], ext: '.mp3', saves: true },
  { file: 'a.aifc', codecArgs: ['-c:a', 'pcm_s16be', '-f', 'aiff'], ext: '.mp3', saves: true },
  { file: 'a-pcm.caf', codecArgs: ['-c:a', 'pcm_s16le'], ext: '.mp3', saves: true },
  { file: 'a-alac.caf', codecArgs: ['-c:a', 'alac'], ext: '.mp3', saves: true },
  { file: 'a-alac.m4a', codecArgs: ['-c:a', 'alac'], ext: '.mp3', saves: true },
  { file: 'a.flac', codecArgs: ['-c:a', 'flac'], ext: '.mp3', saves: true },
  { file: 'a.wv', codecArgs: ['-c:a', 'wavpack'], ext: '.mp3', saves: true },
  { file: 'a.tta', codecArgs: ['-c:a', 'tta'], ext: '.mp3', saves: true },
  { file: 'a.au', codecArgs: ['-c:a', 'pcm_s16be'], ext: '.mp3', saves: true },
  { file: 'a.snd', codecArgs: ['-c:a', 'pcm_s16be', '-f', 'au'], ext: '.mp3', saves: true },
  { file: 'a320.mp3', codecArgs: ['-c:a', 'libmp3lame', '-b:a', '320k'], ext: '.mp3', saves: true },
  { file: 'a-mp2.mp2', codecArgs: ['-c:a', 'mp2', '-b:a', '384k'], ext: '.mp3', saves: true },
  { file: 'a256.m4a', codecArgs: ['-c:a', 'aac', '-b:a', '320k'], ext: '.m4a', saves: true },
  { file: 'a256.aac', codecArgs: ['-c:a', 'aac', '-b:a', '320k'], ext: '.m4a', saves: true },
  { file: 'a.m4r', codecArgs: ['-c:a', 'aac', '-b:a', '320k', '-f', 'ipod'], ext: '.m4r', saves: true },
  { file: 'a.3ga', codecArgs: ['-c:a', 'aac', '-b:a', '320k', '-f', 'adts'], ext: '.m4a', saves: true },
  { file: 'a.ogg', codecArgs: ['-c:a', 'libvorbis', '-q:a', '9'], ext: '.ogg', saves: true },
  { file: 'a.oga', codecArgs: ['-c:a', 'libvorbis', '-q:a', '9'], ext: '.ogg', saves: true },
  { file: 'a.opus', codecArgs: ['-c:a', 'libopus', '-b:a', '256k'], ext: '.opus', saves: true },
  { file: 'a.wma', codecArgs: ['-c:a', 'wmav2', '-b:a', '320k'], ext: '.mp3', saves: true },
  { file: 'a.ac3', codecArgs: ['-c:a', 'ac3', '-b:a', '448k'], ext: '.mp3', saves: true },
  // Ya ligeros: se dejan INTACTOS (recodificar solo los degradaria).
  { file: 'ligero.mp3', codecArgs: ['-c:a', 'libmp3lame', '-b:a', '128k'], ext: '.mp3', keeps: true },
  { file: 'ligero.m4a', codecArgs: ['-c:a', 'aac', '-b:a', '96k'], ext: '.m4a', keeps: true },
  { file: 'ligero.ogg', codecArgs: ['-c:a', 'libvorbis', '-q:a', '3'], ext: '.ogg', keeps: true },
  { file: 'voz.opus', codecArgs: ['-c:a', 'libopus', '-b:a', '24k'], ext: '.opus', keeps: true, channels: 1 },
  { file: 'voz.amr', codecArgs: ['-c:a', 'libopencore_amrnb', '-b:a', '12.2k', '-ar', '8000', '-ac', '1'], ext: '.amr', keeps: true, channels: 1, rate: 8000 }
];

module.exports = { run, makeAudio, makeAudiobook, makeTwoTrackMka, FORMATS };
