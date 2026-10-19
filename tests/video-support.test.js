'use strict';

// Soporte de video de 1.0.12: pistas de video extra (no perder contenido) y VP9/AV1 en HEVC.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { optimizeVideo, buildVideoArgs } = require('../src/main/processor/video-optimizer');
const { probeVideo, parseProbeOutput, getFfmpegPath } = require('../src/main/processor/ffmpeg');
const { isSupportedVideo, isSupportedMedia, mediaKind } = require('../src/main/processor/formats');

const header = 'Input #0, matroska,webm, from \'x.mkv\':\n  Duration: 00:00:02.00, start: 0.000000, bitrate: 900 kb/s\n';
const v = (codec, extra = '') => `  Stream #0:0: Video: ${codec}, yuv420p, 1280x720, 25 fps${extra}\n`;

test('pistas de video extra: solo cuentan las reales, no una miniatura ni una portada', () => {
  assert.equal(parseProbeOutput(header + v('h264')).extraVideoStreams, 0);
  const two = header + v('h264') + '  Stream #0:1: Video: hevc, yuv420p, 1280x720, 25 fps\n';
  assert.equal(parseProbeOutput(two).extraVideoStreams, 1);
  const thumb = header + v('h264') + '  Stream #0:1: Video: mjpeg, yuvj420p, 320x180, 90k tbr (attached pic)\n';
  assert.equal(parseProbeOutput(thumb).extraVideoStreams, 0, 'portada');
  const thumb2 = header + v('h264') + '  Stream #0:1: Video: mjpeg, yuvj420p, 320x180, 25 fps\n';
  assert.equal(parseProbeOutput(thumb2).extraVideoStreams, 0, 'miniatura en formato de imagen');
  const png = header + v('h264') + '  Stream #0:1: Video: png, rgb24, 320x180, 25 fps\n';
  assert.equal(parseProbeOutput(png).extraVideoStreams, 0);
});

test('VP9 y AV1 se recodifican en HEVC (en H.264 pesarian mas); H.264 y MPEG-4 siguen en H.264', () => {
  const codecOf = (videoCodec) => {
    const args = buildVideoArgs({ videoCodec, pixFmt: 'yuv420p', width: 1920, height: 1080, audio: [], subtitles: [], durationSec: 10, hasVideo: true, interlaced: false, extraVideoStreams: 0 },
      { quality: 90 }, 'in.webm', 'out.mp4');
    return args[args.indexOf('-c:v') + 1];
  };
  assert.equal(codecOf('vp9'), 'libx265');
  assert.equal(codecOf('av1'), 'libx265');
  assert.equal(codecOf('hevc'), 'libx265');
  assert.equal(codecOf('h264'), 'libx264');
  assert.equal(codecOf('mpeg4'), 'libx264');
  assert.equal(codecOf('vp8'), 'libx264');
});

test('extensiones nuevas: se reconocen como video; las ambiguas o peligrosas NO', () => {
  for (const ext of ['.3gpp', '.3gpp2', '.m2t', '.trp', '.tp', '.tod', '.vro', '.evo', '.m2p', '.dvr-ms', '.ogm', '.ivf', '.mk3d', '.nut', '.mpv', '.m1v', '.mjpeg', '.mjpg', '.gxf', '.y4m']) {
    assert.equal(isSupportedVideo(`/x/clip${ext}`), true, ext);
    assert.equal(mediaKind(`/x/CLIP${ext.toUpperCase()}`), 'video', `${ext} en mayusculas`);
  }
  // .ts es TypeScript; .mod es go.mod/musica de tracker; .ps es PostScript; .insv/.360 tienen dos lentes.
  for (const ext of ['.ts', '.mod', '.ps', '.dat', '.264', '.h264', '.insv', '.360', '.swf']) {
    assert.equal(isSupportedMedia(`/x/archivo${ext}`), false, `${ext} no debe tomarse por video`);
  }
});

test('REAL: un video con dos pistas de video se deja INTACTO (no se pierde una)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-2v-'));
  try {
    const input = path.join(dir, 'doble.mkv');
    const r = spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=2', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-map', '0:v', '-map', '1:v', '-map', '2:a', '-c:v', 'libx264', '-crf', '10', '-c:a', 'aac', input]);
    assert.equal(r.status, 0);
    const report = await optimizeVideo(input, path.join(dir, 'out', 'doble.mkv'), { quality: 90 });
    assert.equal(report.skipped, true);
    assert.equal(report.reason, 'varios-videos');
    assert.deepEqual(await fs.readFile(report.output), await fs.readFile(input), 'copia identica');
    assert.equal((await probeVideo(report.output)).extraVideoStreams, 1, 'siguen las dos pistas');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('REAL: un video con portada/miniatura incrustada se sigue comprimiendo (no cuenta como segunda pista)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-thumb-'));
  try {
    const input = path.join(dir, 'con_miniatura.mp4');
    const cover = path.join(dir, 'c.jpg');
    spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=1:duration=1', '-frames:v', '1', cover]);
    const r = spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3', '-i', cover, '-map', '0:v', '-map', '1:v',
      '-c:v:0', 'libx264', '-crf', '8', '-c:v:1', 'copy', '-disposition:v:1', 'attached_pic', input]);
    assert.equal(r.status, 0);
    const report = await optimizeVideo(input, path.join(dir, 'out', 'con_miniatura.mp4'), { quality: 90 });
    assert.notEqual(report.reason, 'varios-videos');
    assert.equal(report.skipped, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('REAL: un video VP9 (WebM) sale en HEVC dentro de un MP4 con la misma duracion', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-vp9-'));
  try {
    const input = path.join(dir, 'descarga.webm');
    const r = spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3',
      '-c:v', 'libvpx-vp9', '-crf', '5', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '8', input]);
    assert.equal(r.status, 0);
    const report = await optimizeVideo(input, path.join(dir, 'out', 'descarga.webm'), { quality: 90 });
    if (!report.skipped) {
      const out = await probeVideo(report.output);
      assert.equal(out.videoCodec, 'hevc');
      assert.ok(Math.abs(out.durationSec - 3) < 0.4);
    }
    assert.ok(report.newBytes <= report.originalBytes);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ prueba de peso de video (1.0.12)

const { buildVideoTrialArgs, projectedSizeRatio } = require('../src/main/processor/video-optimizer');

const longProbe = { durationSec: 600, hasVideo: true, videoCodec: 'h264', pixFmt: 'yuv420p', width: 1920, height: 1080, interlaced: false, extraVideoStreams: 0, subtitles: [], audio: [{ codec: 'aac', bitrateKbps: 128 }] };

test('prueba de peso de video: mismos ajustes que el archivo real, solo video, a un pipe', () => {
  const real = buildVideoArgs(longProbe, { quality: 90 }, 'in.mp4', 'out.mp4');
  const trial = buildVideoTrialArgs(longProbe, { quality: 90 }, 'in.mp4', { start: 100, length: 8 });
  assert.deepEqual(trial.slice(0, 4), ['-ss', '100', '-t', '8']);
  assert.equal(trial[trial.length - 1], 'pipe:1');
  assert.ok(trial.includes('-an'), 'sin audio');
  // El codificador, preset y CRF son EXACTAMENTE los del archivo real (si no, la estimacion no valdria).
  for (const flag of ['-c:v', '-preset', '-crf', '-pix_fmt']) assert.equal(trial[trial.indexOf(flag) + 1], real[real.indexOf(flag) + 1], flag);
  const hevc = buildVideoTrialArgs({ ...longProbe, videoCodec: 'vp9' }, { quality: 90 }, 'in.webm', { start: 0, length: 8 });
  assert.equal(hevc[hevc.indexOf('-f') + 1], 'hevc');
  assert.equal(trial[trial.indexOf('-f') + 1], 'h264');
  const interlaced = buildVideoTrialArgs({ ...longProbe, interlaced: true }, { quality: 90 }, 'in.mpg', { start: 0, length: 8 });
  assert.ok(interlaced.some((a) => a.includes('yadif')), 'los filtros tambien cuentan en el peso');
});

test('prueba de peso de video: no se hace con videos cortos ni de duracion desconocida', async () => {
  assert.equal(await projectedSizeRatio({ ...longProbe, durationSec: 120 }, { quality: 90 }, 'x.mp4', 1e6), null);
  assert.equal(await projectedSizeRatio({ ...longProbe, durationSec: 0 }, { quality: 90 }, 'x.mp4', 1e6), null);
  assert.equal(await projectedSizeRatio(longProbe, { quality: 90 }, '/no/existe.mp4', 1e6), null, 'si no se puede medir, se codifica normal');
});

async function longClip(dir, name, crf) {
  const file = path.join(dir, name);
  const r = spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=200',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=200', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-c:a', 'aac', '-b:a', '64k', '-shortest', file]);
  assert.equal(r.status, 0, String(r.stderr));
  return file;
}

test('REAL: un video largo ya muy comprimido se salta SIN codificarlo entero (copia identica)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-vt1-'));
  try {
    const input = await longClip(dir, 'ligero.mp4', 38);
    const started = Date.now();
    const report = await optimizeVideo(input, path.join(dir, 'out', 'ligero.mp4'), { quality: 90 });
    const elapsed = Date.now() - started;
    assert.equal(report.skipped, true);
    assert.equal(report.reason, 'ya-optimizado');
    assert.deepEqual(await fs.readFile(report.output), await fs.readFile(input));
    assert.ok(elapsed < 8000, `la prueba corta debe ser rapida (${elapsed} ms)`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('REAL: un video largo de mucha calidad SI se codifica y baja de peso', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-vt2-'));
  try {
    const input = await longClip(dir, 'pesado.mp4', 12);
    const report = await optimizeVideo(input, path.join(dir, 'out', 'pesado.mp4'), { quality: 90 });
    assert.equal(report.skipped, false);
    assert.ok(report.newBytes < report.originalBytes * 0.8, `${report.originalBytes} -> ${report.newBytes}`);
    const out = await probeVideo(report.output);
    assert.ok(Math.abs(out.durationSec - 200) < 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
