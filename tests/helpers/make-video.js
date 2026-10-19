'use strict';

// Genera videos de prueba REALES con el propio ffmpeg del proyecto (sin
// archivos binarios en el repositorio). Los parametros por defecto producen
// un video "pesado" (CRF 12) para que haya margen de compresion.

const { spawnSync } = require('child_process');
const { getFfmpegPath } = require('../../src/main/processor/ffmpeg');

function run(args) {
  const r = spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg fallo al preparar la prueba: ${r.stderr}`);
}

/**
 * opts: { size, seconds, codec: 'h264'|'hevc10'|'h264-444', audio: 'aac'|'opus'|null, crf }
 */
function makeVideo(outputPath, opts = {}) {
  const { size = '320x240', seconds = 3, codec = 'h264', audio = 'aac', crf = 12, crop } = opts;
  const args = ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  // format=yuv444p antes del recorte: en 4:2:0 ffmpeg redondea a pares y no saldria impar.
  if (crop) args.push('-vf', `format=yuv444p,crop=${crop}`);
  if (codec === 'hevc10') args.push('-pix_fmt', 'yuv420p10le', '-c:v', 'libx265', '-crf', String(crf), '-tag:v', 'hvc1', '-x265-params', 'log-level=error');
  else if (codec === 'h264-444') args.push('-pix_fmt', 'yuv444p', '-c:v', 'libx264', '-crf', String(crf));
  else args.push('-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', String(crf));
  if (audio === 'aac') args.push('-c:a', 'aac', '-b:a', '128k');
  if (audio === 'opus') args.push('-c:a', 'libopus');
  args.push(outputPath);
  run(args);
}

/** Solo audio dentro de un contenedor .mp4 (no es un video). */
function makeAudioOnly(outputPath) {
  run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', outputPath]);
}

/** SSIM global (1.0 = identico) entre dos videos del mismo tamano. */
function ssim(a, b) {
  const r = spawnSync(getFfmpegPath(), ['-hide_banner', '-i', a, '-i', b, '-lavfi',
    '[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]ssim', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /All:([0-9.]+)/.exec(r.stderr);
  if (!m) throw new Error(`no se pudo medir el SSIM: ${r.stderr}`);
  return Number(m[1]);
}

const fs = require('fs');

const SRT = '1\n00:00:00,200 --> 00:00:01,200\nHola mundo\n\n2\n00:00:01,500 --> 00:00:02,500\nSegunda linea\n';
const ASS = `[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour\nStyle: Default,Arial,20,&H00FFFFFF\n\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:00.20,0:00:01.20,Default,{\\\\an8\\\\i1}Estilo avanzado\n`;

/**
 * Video con subtitulos reales. kind:
 *  - 'srt-mp4': un SRT (espanol) dentro de un MP4 (mov_text)
 *  - 'mkv-ass-srt': ASS (ingles, "por defecto") + SRT (espanol, "forzado") en MKV
 */
function makeVideoWithSubtitles(outputPath, kind) {
  const base = outputPath + '.base.mp4';
  makeVideo(base, { seconds: 3 });
  const srt = outputPath + '.srt';
  const ass = outputPath + '.ass';
  fs.writeFileSync(srt, SRT);
  fs.writeFileSync(ass, ASS);
  if (kind === 'srt-mp4') {
    run(['-i', base, '-i', srt, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=spa', outputPath]);
  } else {
    run(['-i', base, '-i', ass, '-i', srt, '-map', '0', '-map', '1', '-map', '2', '-c', 'copy', '-c:s:0', 'ass', '-c:s:1', 'subrip',
      '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=spa', '-disposition:s:0', 'default', '-disposition:s:1', 'forced', outputPath]);
  }
  for (const f of [base, srt, ass]) fs.unlinkSync(f);
}

module.exports = { makeVideo, makeVideoWithSubtitles, makeAudioOnly, ssim };
