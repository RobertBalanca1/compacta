'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { makeVideo, makeVideoWithSubtitles, makeAudioOnly, ssim } = require('./helpers/make-video');
const { optimizeVideo, buildVideoArgs, planContainer, crfFor } = require('../src/main/processor/video-optimizer');
const { parseProbeOutput, probeVideo } = require('../src/main/processor/ffmpeg');

async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `compacta-${prefix}-`));
}
const probeBase = { hasVideo: true, videoCodec: 'h264', pixFmt: 'yuv420p', width: 320, height: 240, audio: [{ codec: 'aac', heavy: false }] };
const argValue = (args, flag) => args[args.indexOf(flag) + 1];

// ---------------------------------------------------------------- puro
test('calidad -> CRF: 90 (por defecto) = 20, 100 = 17, y agresivo siempre comprime mas', () => {
  assert.equal(crfFor(90, false, 'x264'), 20);
  assert.equal(crfFor(100, false, 'x264'), 17);
  assert.equal(crfFor(60, false, 'x264'), 29);
  assert.ok(crfFor(90, true, 'x264') > crfFor(90, false, 'x264'));
  assert.equal(crfFor(90, false, 'x265'), 25, 'x265 usa un CRF ~5 mas alto para la misma calidad');
  assert.equal(crfFor(NaN, false, 'x264'), 20, 'sin calidad valida usa 90');
  assert.ok(crfFor(1, true, 'x264') <= 36, 'nunca se pasa de un CRF razonable');
});

test('argumentos: H.264 8 bits, calidad constante, audio AAC copiado, sin reescalar', () => {
  const args = buildVideoArgs(probeBase, { quality: 90 }, '/in.mov', '/out.mp4');
  assert.equal(argValue(args, '-c:v'), 'libx264');
  assert.equal(argValue(args, '-crf'), '20');
  assert.equal(argValue(args, '-preset'), 'fast');
  assert.equal(argValue(args, '-pix_fmt'), 'yuv420p');
  assert.equal(argValue(args, '-c:a'), 'copy', 'AAC se copia: cero perdida de audio');
  assert.equal(argValue(args, '-fps_mode'), 'passthrough', 'no se duplican ni descartan fotogramas');
  assert.equal(argValue(args, '-map_metadata'), '0');
  assert.ok(!args.includes('-vf') && !args.includes('-s') && !args.includes('-r'), 'nunca reescala ni cambia los fps');
  assert.equal(args[args.length - 1], '/out.mp4');
});

test('argumentos: HEVC / 10 bits se mantienen en HEVC, conservan los bits y salen en 4:2:0', () => {
  const cases = [
    [{ ...probeBase, videoCodec: 'hevc' }, 'yuv420p'],
    [{ ...probeBase, videoCodec: 'h264', pixFmt: 'yuv420p10le' }, 'yuv420p10le'],
    [{ ...probeBase, videoCodec: 'prores', pixFmt: 'yuv422p10le' }, 'yuv420p10le'], // 4:2:2 no lo reproduce casi nada
    [{ ...probeBase, videoCodec: 'hevc', pixFmt: 'yuv420p12le' }, 'yuv420p10le']
  ];
  for (const [probe, expectedPixFmt] of cases) {
    const args = buildVideoArgs(probe, { quality: 90 }, '/in', '/out');
    assert.equal(argValue(args, '-c:v'), 'libx265', probe.pixFmt);
    assert.equal(argValue(args, '-tag:v'), 'hvc1', 'compatible con Apple');
    assert.equal(argValue(args, '-pix_fmt'), expectedPixFmt, probe.pixFmt);
  }
});

test('argumentos: video entrelazado se desentrelaza, y se combina con el pad si hace falta', () => {
  assert.equal(argValue(buildVideoArgs({ ...probeBase, interlaced: true }, {}, '/i', '/o'), '-vf'), 'yadif=0:-1:0');
  assert.equal(argValue(buildVideoArgs({ ...probeBase, interlaced: true, width: 321 }, {}, '/i', '/o'), '-vf'), 'yadif=0:-1:0,pad=ceil(iw/2)*2:ceil(ih/2)*2');
  assert.ok(!buildVideoArgs(probeBase, {}, '/i', '/o').includes('-vf'), 'progresivo y par: sin filtros');
});

test('argumentos: audio que MP4 no admite se recodifica; 5.1 recibe mas tasa', () => {
  const opus = buildVideoArgs({ ...probeBase, audio: [{ codec: 'opus', heavy: false }] }, {}, '/i', '/o');
  assert.equal(argValue(opus, '-c:a'), 'aac');
  assert.equal(argValue(opus, '-b:a'), '160k');
  const surround = buildVideoArgs({ ...probeBase, audio: [{ codec: 'ac3', heavy: true }] }, {}, '/i', '/o');
  assert.equal(argValue(surround, '-b:a'), '384k');
  const mixed = buildVideoArgs({ ...probeBase, audio: [{ codec: 'aac', heavy: false }, { codec: 'opus', heavy: false }] }, {}, '/i', '/o');
  assert.equal(argValue(mixed, '-c:a'), 'aac', 'si alguna pista no se puede copiar, se recodifican todas de forma uniforme');
  const silent = buildVideoArgs({ ...probeBase, audio: [] }, {}, '/i', '/o');
  assert.equal(argValue(silent, '-c:a'), 'copy', 'sin audio no hay nada que recodificar');
});

test('argumentos: agresivo y compresion maxima cambian CRF y preset', () => {
  const aggressive = buildVideoArgs(probeBase, { quality: 90, aggressive: true }, '/i', '/o');
  assert.ok(Number(argValue(aggressive, '-crf')) > 20);
  const max = buildVideoArgs(probeBase, { quality: 90, maxCompression: true }, '/i', '/o');
  assert.equal(argValue(max, '-preset'), 'slow');
  assert.equal(argValue(max, '-crf'), '20', 'la compresion maxima no baja la calidad: solo busca mejor');
});

test('argumentos: dimensiones impares reciben 1 pixel de borde, no un recorte', () => {
  const args = buildVideoArgs({ ...probeBase, width: 321, height: 241 }, {}, '/i', '/o');
  assert.match(argValue(args, '-vf'), /pad=ceil\(iw\/2\)\*2:ceil\(ih\/2\)\*2/);
});

test('parseProbeOutput entiende 10 bits con comas dentro de parentesis y varias pistas de audio', () => {
  const text = [
    'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'x.mov\':',
    '  Duration: 00:01:02.50, start: 0.000000, bitrate: 25000 kb/s',
    '  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 3840x2160, 24000 kb/s, 29.97 fps',
    '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 190 kb/s',
    '  Stream #0:2[0x3](und): Audio: ac3 (ac-3 / 0x332D6361), 48000 Hz, 5.1(side), fltp, 384 kb/s'
  ].join('\n');
  const info = parseProbeOutput(text);
  assert.equal(info.durationSec, 62.5);
  assert.equal(info.videoCodec, 'hevc');
  assert.equal(info.pixFmt, 'yuv420p10le');
  assert.equal(info.width, 3840);
  assert.equal(info.height, 2160);
  assert.deepEqual(info.audio.map((a) => [a.codec, a.heavy]), [['aac', false], ['ac3', true]]);
});

test('parseProbeOutput: una portada (attached pic) no cuenta como video', () => {
  const info = parseProbeOutput([
    '  Duration: 00:03:00.00, start: 0.0, bitrate: 320 kb/s',
    '  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s',
    '  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 500x500, 90k tbr (attached pic)'
  ].join('\n'));
  assert.equal(info.hasVideo, false);
});

// ---------------------------------------------------------------- real
test('comprime un video real: mas pequeno, misma duracion y resolucion, y calidad visual intacta (SSIM)', async () => {
  const dir = await tmpDir('vid-real');
  const input = path.join(dir, 'clip.mp4');
  makeVideo(input);
  let lastProgress = 0;
  const report = await optimizeVideo(input, path.join(dir, 'out', 'clip.mp4'), { quality: 90 }, (p) => { lastProgress = Math.max(lastProgress, p); });

  assert.equal(report.skipped, false);
  assert.ok(report.newBytes < report.originalBytes * 0.95, `debe ahorrar bastante (ahorro ${report.savedPercent}%)`);
  const before = await probeVideo(input);
  const after = await probeVideo(report.output);
  assert.equal(after.width, before.width);
  assert.equal(after.height, before.height);
  assert.ok(Math.abs(after.durationSec - before.durationSec) < 0.2, 'misma duracion');
  assert.deepEqual(after.audio.map((a) => a.codec), ['aac'], 'el audio sigue ahi');
  assert.ok(ssim(input, report.output) > 0.98, 'calidad visual practicamente identica');
  assert.ok(lastProgress > 0.9, `debe informar del avance (llego a ${lastProgress})`);
  const leftovers = (await fs.readdir(path.dirname(report.output))).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'sin temporales sobrantes');
  await fs.rm(dir, { recursive: true, force: true });
});

test('un .mov o .mkv sale como .mp4 y el nombre es el esperado', async () => {
  const dir = await tmpDir('vid-ext');
  const input = path.join(dir, 'viaje.mkv');
  makeVideo(input, { audio: 'opus' });
  const report = await optimizeVideo(input, path.join(dir, 'out', 'viaje.mkv'), { quality: 90 });
  assert.equal(path.basename(report.output), 'viaje.mp4');
  assert.deepEqual((await probeVideo(report.output)).audio.map((a) => a.codec), ['aac'], 'opus no cabe en mp4: se pasa a AAC');
  await fs.rm(dir, { recursive: true, force: true });
});

test('HEVC de 10 bits sigue siendo HEVC de 10 bits (no se pierde el HDR)', async () => {
  const dir = await tmpDir('vid-hevc');
  const input = path.join(dir, 'hdr.mp4');
  makeVideo(input, { codec: 'hevc10', audio: null });
  const report = await optimizeVideo(input, path.join(dir, 'out', 'hdr.mp4'), { quality: 90 });
  const after = await probeVideo(report.output);
  assert.equal(after.videoCodec, 'hevc');
  assert.equal(after.pixFmt, 'yuv420p10le');
  assert.equal(report.skipped, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('un video ya muy comprimido se deja EXACTAMENTE como esta (no se degrada para ahorrar nada)', async () => {
  const dir = await tmpDir('vid-skip');
  const input = path.join(dir, 'ya-ligero.mp4');
  makeVideo(input, { crf: 40, audio: null });
  const report = await optimizeVideo(input, path.join(dir, 'out', 'ya-ligero.mp4'), { quality: 90 });
  assert.equal(report.skipped, true);
  assert.equal(report.reason, 'sin-mejora-posible');
  assert.deepEqual(await fs.readFile(report.output), await fs.readFile(input), 'la salida es una copia byte a byte del original');
  assert.deepEqual((await fs.readdir(path.join(dir, 'out'))).filter((n) => n.includes('.tmp-')), []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('dimensiones impares: se procesa bien anadiendo un pixel de borde', async () => {
  const dir = await tmpDir('vid-odd');
  const input = path.join(dir, 'impar.mp4');
  makeVideo(input, { size: '640x480', codec: 'h264-444', crop: '321:241:0:0', audio: null });
  const before = await probeVideo(input);
  assert.equal(before.width % 2, 1, 'el origen de la prueba tiene ancho impar');
  const report = await optimizeVideo(input, path.join(dir, 'out', 'impar.mp4'), { quality: 90 });
  const after = await probeVideo(report.output);
  assert.equal(after.width, before.width + 1);
  assert.equal(after.height, before.height + 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('un archivo .mp4 que solo tiene audio se trata como AUDIO (aqui ya es ligero: se deja intacto y se informa)', async () => {
  const dir = await tmpDir('vid-audio');
  const input = path.join(dir, 'solo-audio.mp4');
  makeAudioOnly(input);
  const report = await optimizeVideo(input, path.join(dir, 'out', 'solo-audio.mp4'), {});
  assert.equal(report.skipped, true);
  assert.equal(report.reason, 'ya-optimizado');
  assert.deepEqual(await fs.readFile(report.output), await fs.readFile(input));
  await fs.rm(dir, { recursive: true, force: true });
});

test('un archivo corrupto falla con un error claro y no deja restos en la salida', async () => {
  const dir = await tmpDir('vid-bad');
  const input = path.join(dir, 'roto.mp4');
  await fs.writeFile(input, Buffer.from('esto no es un video, solo texto para probar un archivo corrupto'));
  await assert.rejects(() => optimizeVideo(input, path.join(dir, 'out', 'roto.mp4'), {}), /no es un v[ií]deo v[aá]lido o est[aá] da[nñ]ado/);
  const names = await fs.readdir(path.join(dir, 'out')).catch(() => []);
  assert.deepEqual(names, [], 'ni salida a medias ni temporales');
  await fs.rm(dir, { recursive: true, force: true });
});

test('calidad mas baja = archivo mas pequeno, y el modo agresivo ahorra todavia mas', async () => {
  const dir = await tmpDir('vid-q');
  const input = path.join(dir, 'clip.mp4');
  makeVideo(input);
  const high = await optimizeVideo(input, path.join(dir, 'o1', 'clip.mp4'), { quality: 100 });
  const normal = await optimizeVideo(input, path.join(dir, 'o2', 'clip.mp4'), { quality: 90 });
  const low = await optimizeVideo(input, path.join(dir, 'o3', 'clip.mp4'), { quality: 70 });
  const aggressive = await optimizeVideo(input, path.join(dir, 'o4', 'clip.mp4'), { quality: 90, aggressive: true });
  assert.ok(high.newBytes > normal.newBytes && normal.newBytes > low.newBytes, 'el tamano baja con la calidad');
  assert.ok(aggressive.newBytes < normal.newBytes, 'agresivo comprime mas que normal');
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- subtitulos
test('subtitulos: de texto simple -> MP4 con mov_text; con estilo o de imagen -> MKV copiandolos', () => {
  const srt = { index: 2, codec: 'subrip', language: 'spa' };
  const ass = { index: 3, codec: 'ass', language: 'eng' };
  const pgs = { index: 4, codec: 'hdmv_pgs_subtitle', language: 'eng' };
  const cc = { index: 5, codec: 'eia_608', language: null };

  assert.equal(planContainer({ ...probeBase, subtitles: [] }).extension, '.mp4');
  assert.equal(planContainer({ ...probeBase, subtitles: [srt] }).extension, '.mp4');
  assert.equal(planContainer({ ...probeBase, subtitles: [srt, ass] }).extension, '.mkv');
  assert.equal(planContainer({ ...probeBase, subtitles: [pgs] }).extension, '.mkv');
  assert.deepEqual(planContainer({ ...probeBase, subtitles: [cc] }).subtitles, [], 'closed captions: no son una pista, viajan dentro del video');

  const mp4 = buildVideoArgs({ ...probeBase, subtitles: [srt] }, {}, '/i', '/o.mp4');
  assert.equal(argValue(mp4, '-c:s'), 'mov_text');
  assert.equal(argValue(mp4, '-f'), 'mp4');
  assert.ok(mp4.join(' ').includes('-map 0:2'), 'se mapea la pista por su indice');
  assert.ok(!mp4.includes('0:t?'), 'las fuentes incrustadas solo en MKV');

  const mkv = buildVideoArgs({ ...probeBase, audio: [{ codec: 'ac3', heavy: true }], subtitles: [srt, ass, pgs] }, {}, '/i', '/o.mkv');
  assert.equal(argValue(mkv, '-c:s'), 'copy');
  assert.equal(argValue(mkv, '-f'), 'matroska');
  assert.equal(argValue(mkv, '-c:a'), 'copy', 'en MKV el audio se copia sea cual sea su formato (AC3 incluido)');
  for (const idx of [2, 3, 4]) assert.ok(mkv.join(' ').includes(`-map 0:${idx}`), `pista ${idx}`);
  assert.ok(mkv.includes('0:t?'), 'y se conservan las fuentes incrustadas');
  assert.ok(!mkv.includes('+faststart'), 'faststart es solo de MP4');
});

test('parseProbeOutput: lee indice, codec e idioma de los subtitulos (con ambos estilos de linea)', () => {
  const info = parseProbeOutput([
    '  Duration: 00:00:03.00, start: 0.000000, bitrate: 900 kb/s',
    '  Stream #0:0(und): Video: h264 (High), yuv420p(progressive), 320x240, 30 fps',
    '  Stream #0:1(eng): Audio: aac (LC), 44100 Hz, mono, fltp',
    '  Stream #0:2(spa): Subtitle: subrip (default) (forced)',
    '  Stream #0:3[0x1](eng): Subtitle: mov_text (tx3g / 0x67337874)',
    '  Stream #0:4: Subtitle: hdmv_pgs_subtitle (pgssub)'
  ].join('\n'));
  assert.deepEqual(info.subtitles, [
    { index: 2, codec: 'subrip', language: 'spa' },
    { index: 3, codec: 'mov_text', language: 'eng' },
    { index: 4, codec: 'hdmv_pgs_subtitle', language: null }
  ]);
});

test('REAL: un SRT dentro de un MP4 se conserva (mismo texto, mismo idioma) y el video sale .mp4', async () => {
  const dir = await tmpDir('sub-mp4');
  const input = path.join(dir, 'peli.mp4');
  makeVideoWithSubtitles(input, 'srt-mp4');
  const before = await probeVideo(input);
  assert.equal(before.subtitles.length, 1, 'el origen de la prueba trae 1 subtitulo');

  const report = await optimizeVideo(input, path.join(dir, 'out', 'peli.mp4'), { quality: 90 });

  assert.ok(report.output.endsWith('.mp4'));
  const after = await probeVideo(report.output);
  assert.equal(after.subtitles.length, 1, 'el subtitulo NO se pierde');
  assert.equal(after.subtitles[0].language, 'spa', 'ni su idioma');
  // El texto sigue ahi: se extrae a SRT y se comprueba.
  const { spawnSync } = require('child_process');
  const { getFfmpegPath } = require('../src/main/processor/ffmpeg');
  const srt = spawnSync(getFfmpegPath(), ['-v', 'error', '-i', report.output, '-map', '0:s:0', '-f', 'srt', '-'], { encoding: 'utf8' }).stdout;
  assert.match(srt, /Hola mundo/);
  assert.match(srt, /Segunda linea/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('REAL: ASS + SRT en MKV salen como .mkv con AMBOS subtitulos, idiomas y marcas intactos', async () => {
  const dir = await tmpDir('sub-mkv');
  const input = path.join(dir, 'serie.mkv');
  makeVideoWithSubtitles(input, 'mkv-ass-srt');
  const before = await probeVideo(input);
  assert.deepEqual(before.subtitles.map((s) => s.codec), ['ass', 'subrip']);

  const report = await optimizeVideo(input, path.join(dir, 'out', 'serie.mkv'), { quality: 90 });

  assert.ok(report.output.endsWith('.mkv'), 'MP4 no puede guardar ASS: sale como MKV');
  const after = await probeVideo(report.output);
  assert.deepEqual(after.subtitles.map((s) => [s.codec, s.language]), [['ass', 'eng'], ['subrip', 'spa']], 'mismos codecs e idiomas, en el mismo orden');
  const { spawnSync } = require('child_process');
  const { getFfmpegPath } = require('../src/main/processor/ffmpeg');
  const info = spawnSync(getFfmpegPath(), ['-hide_banner', '-i', report.output], { encoding: 'utf8' }).stderr;
  assert.match(info, /Subtitle: (?:ass|ssa)[^\n]*\(default\)|Subtitle: .*default/i, 'marca "por defecto" conservada');
  assert.match(info, /Subtitle: subrip[^\n]*\(forced\)/, 'marca "forzado" conservada');
  assert.deepEqual(await fs.readdir(path.dirname(report.output)).then((n) => n.filter((x) => x.includes('.tmp-'))), []);
  await fs.rm(dir, { recursive: true, force: true });
});
