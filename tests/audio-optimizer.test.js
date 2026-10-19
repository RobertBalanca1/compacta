'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeAudio, makeAudiobook, makeTwoTrackMka, FORMATS, run } = require('./helpers/make-audio');
const { optimizeAudio, planAudio, buildAudioArgs, chooseFamily, aacKbps, mp3VbrLevel, opusKbps, vorbisQuality, expectedKbps, outputSampleRate, effectiveQuality } = require('../src/main/processor/audio-optimizer');
const { optimizeVideo } = require('../src/main/processor/video-optimizer');
const { probeVideo, parseProbeOutput, getFfmpegPath } = require('../src/main/processor/ffmpeg');
const { processMedia } = require('../src/main/processor');
const { mediaKind, isSupportedMedia, AUDIO_EXTENSIONS } = require('../src/main/processor/formats');

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'compacta-audio-'));

/** Decodifica TODO el archivo: si esta roto, ffmpeg sale con error. */
function decodes(file) {
  const r = spawnSync(getFfmpegPath(), ['-hide_banner', '-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  return r.status === 0 && r.stderr.trim() === '';
}

const probeBase = { durationSec: 4, bitrateKbps: 0, hasCover: false, audio: [{ codec: 'pcm_s16le', channels: 2, sampleRate: 44100, bitrateKbps: 1411 }] };
const plan = (probeOverrides, options = { quality: 90 }, bytes = 700000, inputPath = '/x/a.wav') => planAudio({ ...probeBase, ...probeOverrides }, options, inputPath, bytes);

// ---------------------------------------------------------------- reconocer formatos
test('todos los formatos de audio (incluidos los de Mac) se reconocen como audio, y los de otro tipo no', () => {
  for (const ext of ['.mp3', '.m4a', '.m4b', '.m4r', '.aac', '.wav', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.aifc', '.caf', '.amr', '.ac3', '.mka', '.ape', '.wv']) {
    assert.equal(mediaKind(`/x/Cancion${ext}`), 'audio', ext);
    assert.equal(mediaKind(`/x/CANCION${ext.toUpperCase()}`), 'audio', `${ext} en mayusculas`);
    assert.ok(isSupportedMedia(`/x/c${ext}`));
  }
  assert.equal(mediaKind('/x/foto.jpg'), 'image');
  assert.equal(mediaKind('/x/peli.mp4'), 'video');
  assert.equal(mediaKind('/x/._cancion.mp3'), null, 'la basura de Mac no es un audio');
  assert.equal(mediaKind('/x/notas.mid'), null);
  assert.ok(AUDIO_EXTENSIONS.size >= 40);
});

// ---------------------------------------------------------------- analisis de ffmpeg
test('el analisis de ffmpeg entiende frecuencia, canales, tasa de bits y portada', () => {
  const info = parseProbeOutput(`  Duration: 00:03:00.04, start: 0.025057, bitrate: 320 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 500x500, 90k tbr (attached pic)`);
  assert.deepEqual(info.audio[0], { codec: 'mp3', heavy: false, sampleRate: 44100, channels: 2, bitrateKbps: 320 });
  assert.equal(info.hasCover, true);
  assert.equal(info.hasVideo, false, 'una portada no es un video');
  assert.equal(info.bitrateKbps, 320);
  const layouts = { 'mono, fltp': 1, 'stereo, s16': 2, '5.1(side), s16': 6, '7.1, fltp': 8, '2 channels, fltp': 2, '3 channels, s16': 3, 'quad, fltp': 4 };
  for (const [text, channels] of Object.entries(layouts)) {
    assert.equal(parseProbeOutput(`  Stream #0:0: Audio: pcm_s16le, 48000 Hz, ${text}, 768 kb/s`).audio[0].channels, channels, text);
  }
});

// ---------------------------------------------------------------- decisiones (puras)
test('calidad -> parametros: 90 es transparente y cada codec sube y baja con la barra', () => {
  assert.equal(effectiveQuality(90, false), 90);
  assert.equal(effectiveQuality(90, true), 75);
  assert.equal(aacKbps(90, 2), 192);
  assert.equal(aacKbps(100, 2), 256);
  assert.ok(aacKbps(60, 2) < aacKbps(90, 2));
  assert.ok(aacKbps(90, 1) < aacKbps(90, 2) && aacKbps(90, 6) > aacKbps(90, 2), 'mono menos, 5.1 mas');
  assert.equal(mp3VbrLevel(90), 2);
  assert.equal(mp3VbrLevel(100), 0);
  assert.ok(mp3VbrLevel(60) > mp3VbrLevel(90));
  assert.equal(opusKbps(90, 2), 128);
  assert.ok(opusKbps(100, 2) > 128 && opusKbps(60, 2) < 128);
  assert.ok(vorbisQuality(100) > vorbisQuality(90) && vorbisQuality(90) > vorbisQuality(60));
  for (let q = 60; q < 100; q += 4) {
    assert.ok(expectedKbps('mp3', q, 2) <= expectedKbps('mp3', q + 4, 2), `mp3 ${q}`);
    assert.ok(expectedKbps('aac', q, 2) <= expectedKbps('aac', q + 4, 2), `aac ${q}`);
  }
  assert.ok(expectedKbps('mp3', 75, 2) < expectedKbps('mp3', 90, 2), 'agresivo comprime mas');
});

test('familia de salida segun el codec: MP3 para lo sin perdida, la misma familia para lo que ya es con perdida, AAC si hay mas de 2 canales', () => {
  for (const codec of ['pcm_s16le', 'pcm_s24be', 'flac', 'alac', 'wavpack', 'tta', 'ape', 'wmav2', 'ac3', 'dts', 'amr_nb']) assert.equal(chooseFamily(codec, 2), 'mp3', codec);
  assert.equal(chooseFamily('mp3', 2), 'mp3');
  assert.equal(chooseFamily('aac', 2), 'aac');
  assert.equal(chooseFamily('vorbis', 2), 'vorbis');
  assert.equal(chooseFamily('opus', 1), 'opus');
  assert.equal(chooseFamily('flac', 6), 'aac');
  assert.equal(chooseFamily('ac3', 6), 'aac');
});

test('un audio sin perdida SIEMPRE se recodifica; uno con perdida solo si pesa claramente mas de lo necesario', () => {
  assert.equal(plan({}).skip, null);
  assert.equal(plan({ audio: [{ codec: 'mp3', channels: 2, sampleRate: 44100, bitrateKbps: 320 }] }, { quality: 90 }, 1e6, '/x/a.mp3').skip, null);
  assert.equal(plan({ audio: [{ codec: 'mp3', channels: 2, sampleRate: 44100, bitrateKbps: 128 }] }, { quality: 90 }, 1e6, '/x/a.mp3').skip, 'ya-optimizado');
  assert.equal(plan({ audio: [{ codec: 'opus', channels: 1, sampleRate: 48000, bitrateKbps: 24 }] }, { quality: 90 }, 1e5, '/x/v.opus').skip, 'ya-optimizado');
  // Sin tasa de bits conocida se calcula con peso y duracion.
  assert.equal(plan({ durationSec: 100, audio: [{ codec: 'mp3', channels: 2, sampleRate: 44100, bitrateKbps: 0 }] }, { quality: 90 }, 100 * 64 * 125, '/x/a.mp3').skip, 'ya-optimizado');
});

test('contenedor, extension y portada del plan', () => {
  assert.deepEqual([plan({}).extension, plan({}).format, plan({}).family], ['.mp3', 'mp3', 'mp3']);
  const aac = plan({ audio: [{ codec: 'aac', channels: 2, sampleRate: 44100, bitrateKbps: 320 }] }, { quality: 90 }, 1e6, '/x/a.m4b');
  assert.deepEqual([aac.extension, aac.format], ['.m4b', 'ipod'], 'un audiolibro sigue siendo .m4b');
  assert.equal(plan({ audio: [{ codec: 'aac', channels: 2, sampleRate: 44100, bitrateKbps: 320 }] }, { quality: 90 }, 1e6, '/x/a.aac').extension, '.m4a');
  assert.equal(plan({ audio: [{ codec: 'aac', channels: 2, sampleRate: 44100, bitrateKbps: 320 }] }, { quality: 90 }, 1e6, '/x/peli.mp4').extension, '.m4a');
  assert.equal(plan({ audio: [{ codec: 'vorbis', channels: 2, sampleRate: 44100, bitrateKbps: 320 }] }, {}, 1e6, '/x/a.ogg').extension, '.ogg');
  assert.equal(plan({ audio: [{ codec: 'opus', channels: 2, sampleRate: 48000, bitrateKbps: 256 }] }, {}, 1e6, '/x/a.opus').extension, '.opus');
  const multi = plan({ audio: [probeBase.audio[0], probeBase.audio[0]] });
  assert.deepEqual([multi.extension, multi.format, multi.keepsCover], ['.mka', 'matroska', false]);
  assert.equal(plan({ hasCover: true }).keepsCover, true, 'portada en MP3');
  assert.equal(plan({ hasCover: true, audio: [{ codec: 'opus', channels: 2, sampleRate: 48000, bitrateKbps: 256 }] }, {}, 1e6, '/x/a.opus').keepsCover, false, 'OPUS no la admite');
});

test('si el ffmpeg de esa plataforma no trae un codificador, se usa AAC en vez de fallar', () => {
  const noLame = planAudio(probeBase, { quality: 90 }, '/x/a.wav', 7e5, new Set(['aac', 'flac']));
  assert.equal(noLame.family, 'aac');
  assert.equal(noLame.extension, '.m4a');
  const noOpus = planAudio({ ...probeBase, audio: [{ codec: 'opus', channels: 2, sampleRate: 48000, bitrateKbps: 256 }] }, { quality: 90 }, '/x/a.opus', 1e6, new Set(['aac']));
  assert.equal(noOpus.family, 'aac');
});

test('frecuencia de salida: nunca se sube, mas de 48 kHz se baja y MP3 solo admite las suyas', () => {
  assert.equal(outputSampleRate('mp3', 44100), null);
  assert.equal(outputSampleRate('mp3', 8000), null);
  assert.equal(outputSampleRate('mp3', 96000), 48000);
  assert.equal(outputSampleRate('mp3', 88200), 44100);
  assert.equal(outputSampleRate('mp3', 192000), 48000);
  assert.equal(outputSampleRate('mp3', 37800), 44100, 'una no admitida por MP3');
  assert.equal(outputSampleRate('aac', 44100), null);
  assert.equal(outputSampleRate('aac', 176400), 44100);
  assert.equal(outputSampleRate('opus', 48000), null);
  assert.equal(outputSampleRate('mp3', 0), null);
});

test('argumentos de ffmpeg: etiquetas y capitulos se copian, portada solo si cabe, el contenedor se indica siempre', () => {
  const p = plan({ hasCover: true });
  const args = buildAudioArgs(p, 'in.wav', 'out.tmp');
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value('-c:a'), 'libmp3lame');
  assert.equal(value('-q:a'), '2');
  assert.equal(value('-map_metadata'), '0');
  assert.equal(value('-map_chapters'), '0');
  assert.ok(args.includes('0:v:0') && value('-c:v') === 'copy');
  assert.equal(value('-f'), 'mp3');
  assert.equal(args[args.length - 1], 'out.tmp');
  assert.ok(!buildAudioArgs(p, 'in.wav', 'out.tmp', { withCover: false }).includes('0:v:0'));
  assert.equal(buildAudioArgs(plan({}, { quality: 90, maxCompression: true }), 'a', 'b')[buildAudioArgs(plan({}, { quality: 90, maxCompression: true }), 'a', 'b').indexOf('-compression_level') + 1], '0');
  const six = plan({ audio: [{ codec: 'flac', channels: 6, sampleRate: 48000, bitrateKbps: 3000 }] }, { quality: 90 }, 1e7, '/x/a.flac');
  const sixArgs = buildAudioArgs(six, 'a', 'b');
  assert.equal(sixArgs[sixArgs.indexOf('-c:a') + 1], 'aac');
  assert.equal(sixArgs[sixArgs.indexOf('-b:a') + 1], '384k', '5.1 conserva sus canales con mas tasa de bits');
});

// ---------------------------------------------------------------- audios REALES, formato por formato
for (const fmt of FORMATS) {
  test(`formato real ${fmt.file}: ${fmt.keeps ? 'ya ligero, se deja intacto' : `se comprime y sale como ${fmt.ext}`}`, async () => {
    const dir = await tmpDir();
    try {
      const input = path.join(dir, fmt.file);
      makeAudio(input, { codecArgs: fmt.codecArgs, channels: fmt.channels || 2, rate: fmt.rate || 44100, tags: { title: 'Mi cancion', artist: 'Yo' } });
      const originalBytes = (await fs.stat(input)).size;
      const report = await optimizeAudio(input, path.join(dir, 'out', fmt.file), { quality: 90 });

      assert.equal(path.extname(report.output).toLowerCase(), fmt.ext, `extension de salida (${report.output})`);
      assert.ok(decodes(report.output), 'la salida se reproduce entera, sin errores');
      const probe = await probeVideo(report.output);
      assert.ok(Math.abs(probe.durationSec - 4) < 0.35, `duracion conservada (${probe.durationSec})`);
      if (fmt.keeps) {
        assert.equal(report.skipped, true);
        assert.equal(report.reason, 'ya-optimizado');
        assert.deepEqual(await fs.readFile(report.output), await fs.readFile(input), 'copia identica, sin recodificar');
      } else {
        assert.equal(report.skipped, false, `debia comprimirse (${report.reason})`);
        assert.ok(report.newBytes < originalBytes * 0.95, `${report.newBytes} < ${originalBytes}`);
        assert.equal(report.newBytes, (await fs.stat(report.output)).size);
        // Las etiquetas viajan siempre que el ORIGEN las pudiera guardar (un .aac, .ac3, .w64 o .mp2 sueltos no tienen sitio para ellas).
        const metaOf = (file) => spawnSync(getFfmpegPath(), ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
        if (/Mi cancion/.test(metaOf(input))) assert.match(metaOf(report.output), /Mi cancion/, 'titulo conservado');
      }
      const left = (await fs.readdir(path.join(dir, 'out'))).filter((n) => /\.tmp-/.test(n));
      assert.deepEqual(left, [], 'sin temporales');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test('mayusculas en la extension (CANCION.WAV, como las deja Windows o una camara)', async () => {
  const dir = await tmpDir();
  const input = path.join(dir, 'CANCION.WAV');
  makeAudio(input, { codecArgs: ['-c:a', 'pcm_s16le', '-f', 'wav'] });
  const report = await processMedia(input, path.join(dir, 'out', 'CANCION.WAV'), { quality: 90 });
  assert.equal(path.basename(report.output), 'CANCION.mp3');
  assert.ok(decodes(report.output));
  await fs.rm(dir, { recursive: true, force: true });
});

test('la portada se conserva en MP3 y M4A, y no rompe OGG/OPUS (que no la guardan)', async () => {
  const dir = await tmpDir();
  // (un WAV no puede llevar portada: solo FLAC, MP3 y M4A son casos reales)
  const cases = [['c.flac', ['-c:a', 'flac'], false], ['c320.mp3', ['-c:a', 'libmp3lame', '-b:a', '320k'], true], ['c.m4a', ['-c:a', 'aac', '-b:a', '320k'], true]];
  for (const [file, codecArgs] of cases) {
    const input = path.join(dir, file);
    makeAudio(input, { codecArgs, cover: true });
    assert.equal((await probeVideo(input)).hasCover, true, `${file}: la fuente lleva portada`);
    const report = await optimizeAudio(input, path.join(dir, 'out', file), { quality: 90 });
    assert.equal(report.skipped, false, file);
    assert.equal((await probeVideo(report.output)).hasCover, true, `${file}: portada conservada`);
    assert.ok(decodes(report.output));
  }
  for (const [file, codecArgs] of [['c.ogg', ['-c:a', 'libvorbis', '-q:a', '9']], ['c.wma', ['-c:a', 'wmav2', '-b:a', '320k']]]) {
    const input = path.join(dir, file);
    makeAudio(input, { codecArgs, cover: false });
    const report = await optimizeAudio(input, path.join(dir, 'out', file), { quality: 90 });
    assert.ok(decodes(report.output), file);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('un audiolibro .m4b conserva sus capitulos y su extension', async () => {
  const dir = await tmpDir();
  const input = path.join(dir, 'libro.m4b');
  makeAudiobook(input);
  const before = spawnSync(getFfmpegPath(), ['-hide_banner', '-i', input], { encoding: 'utf8' }).stderr;
  assert.match(before, /Chapter #0:1/, 'la fuente tiene dos capitulos');
  const report = await optimizeAudio(input, path.join(dir, 'out', 'libro.m4b'), { quality: 90 });
  assert.equal(path.extname(report.output), '.m4b');
  assert.equal(report.skipped, false);
  const after = spawnSync(getFfmpegPath(), ['-hide_banner', '-i', report.output], { encoding: 'utf8' }).stderr;
  assert.match(after, /Chapter #0:1/, 'los capitulos siguen');
  assert.match(after, /Capitulo dos/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('con varias pistas de audio (MKA) se guardan todas, en un MKA', async () => {
  const dir = await tmpDir();
  const input = path.join(dir, 'dos.mka');
  makeTwoTrackMka(input);
  const report = await optimizeAudio(input, path.join(dir, 'out', 'dos.mka'), { quality: 90 });
  assert.equal(path.extname(report.output), '.mka');
  assert.equal(report.skipped, false);
  assert.equal((await probeVideo(report.output)).audio.length, 2, 'las dos pistas');
  assert.ok(decodes(report.output));
  await fs.rm(dir, { recursive: true, force: true });
});

test('5.1 sin perdida (FLAC) no se aplasta a estereo: va a AAC conservando los 6 canales', async () => {
  const dir = await tmpDir();
  const input = path.join(dir, 'cine.flac');
  makeAudio(input, { codecArgs: ['-c:a', 'flac'], channels: 6, rate: 48000 });
  const report = await optimizeAudio(input, path.join(dir, 'out', 'cine.flac'), { quality: 90 });
  assert.equal(path.extname(report.output), '.m4a');
  assert.equal((await probeVideo(report.output)).audio[0].channels, 6);
  assert.ok(decodes(report.output));
  await fs.rm(dir, { recursive: true, force: true });
});

test('alta resolucion (96 kHz / 24 bits) sale a 48 kHz en MP3 sin errores', async () => {
  const dir = await tmpDir();
  const input = path.join(dir, 'hires.flac');
  makeAudio(input, { codecArgs: ['-c:a', 'flac', '-sample_fmt', 's32'], rate: 96000 });
  const report = await optimizeAudio(input, path.join(dir, 'out', 'hires.flac'), { quality: 90 });
  assert.equal(path.extname(report.output), '.mp3');
  assert.equal((await probeVideo(report.output)).audio[0].sampleRate, 48000);
  assert.ok(decodes(report.output));
  await fs.rm(dir, { recursive: true, force: true });
});

test('mono se queda en mono, y 8 kHz (telefono / grabadora) no se sube de frecuencia', async () => {
  const dir = await tmpDir();
  const input = path.join(dir, 'tel.wav');
  makeAudio(input, { codecArgs: ['-c:a', 'pcm_s16le'], channels: 1, rate: 8000 });
  const report = await optimizeAudio(input, path.join(dir, 'out', 'tel.wav'), { quality: 90 });
  const track = (await probeVideo(report.output)).audio[0];
  assert.equal(track.channels, 1);
  assert.equal(track.sampleRate, 8000);
  assert.ok(decodes(report.output));
  await fs.rm(dir, { recursive: true, force: true });
});

test('la barra de calidad se nota: 100 pesa mas que 90 y el modo agresivo pesa menos', async () => {
  const dir = await tmpDir();
  const input = path.join(dir, 'q.wav');
  makeAudio(input, { codecArgs: ['-c:a', 'pcm_s16le'], seconds: 6 });
  const size = async (name, options) => (await optimizeAudio(input, path.join(dir, name, 'q.wav'), options)).newBytes;
  const high = await size('hi', { quality: 100 });
  const normal = await size('no', { quality: 90 });
  const aggressive = await size('ag', { quality: 90, aggressive: true });
  assert.ok(high > normal, `${high} > ${normal}`);
  assert.ok(aggressive < normal, `${aggressive} < ${normal}`);
  await fs.rm(dir, { recursive: true, force: true });
});

test('un archivo corrupto con extension de audio falla con un error claro y no deja restos', async () => {
  const dir = await tmpDir();
  for (const name of ['roto.mp3', 'roto.wav', 'roto.m4a', 'roto.caf']) {
    const input = path.join(dir, name);
    await fs.writeFile(input, Buffer.from('esto no es un audio, solo texto para probar un archivo corrupto'));
    await assert.rejects(() => optimizeAudio(input, path.join(dir, 'out', name), { quality: 90 }), /no es un audio v[aá]lido o est[aá] da[nñ]ado/, name);
  }
  assert.deepEqual((await fs.readdir(path.join(dir, 'out')).catch(() => [])), [], 'ni salida a medias ni temporales');
  await fs.rm(dir, { recursive: true, force: true });
});

test('dos audios con el mismo nombre y distinta extension (cancion.wav y cancion.mp3) no se pisan', async () => {
  const dir = await tmpDir();
  makeAudio(path.join(dir, 'cancion.wav'), { codecArgs: ['-c:a', 'pcm_s16le'] });
  makeAudio(path.join(dir, 'cancion.mp3'), { codecArgs: ['-c:a', 'libmp3lame', '-b:a', '320k'] });
  const a = await optimizeAudio(path.join(dir, 'cancion.wav'), path.join(dir, 'out', 'cancion.wav'), { quality: 90 });
  const b = await optimizeAudio(path.join(dir, 'cancion.mp3'), path.join(dir, 'out', 'cancion.mp3'), { quality: 90 });
  assert.notEqual(a.output, b.output);
  assert.equal((await fs.readdir(path.join(dir, 'out'))).length, 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test('una nota de voz en contenedor de video (.3gp, .mp4, .webm, .mkv sin imagen) se comprime como audio', async () => {
  const dir = await tmpDir();
  const cases = [['voz.mp4', ['-c:a', 'aac', '-b:a', '320k']], ['voz.3gp', ['-c:a', 'aac', '-b:a', '320k']], ['voz.mkv', ['-c:a', 'flac']], ['voz.webm', ['-c:a', 'libopus', '-b:a', '256k']]];
  for (const [file, codecArgs] of cases) {
    const input = path.join(dir, file);
    makeAudio(input, { codecArgs });
    const report = await processMedia(input, path.join(dir, 'out', file), { quality: 90 });
    assert.equal(report.skipped, false, file);
    assert.ok(report.newBytes < report.originalBytes, file);
    assert.ok(decodes(report.output), file);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('el progreso llega a la cola y nunca baja', async () => {
  const dir = await tmpDir();
  const input = path.join(dir, 'p.wav');
  makeAudio(input, { codecArgs: ['-c:a', 'pcm_s16le'], seconds: 30 });
  const seen = [];
  await optimizeAudio(input, path.join(dir, 'out', 'p.wav'), { quality: 90 }, (f) => seen.push(f));
  assert.ok(seen.length > 0, 'hubo avance');
  assert.ok(seen.every((f) => f >= 0 && f <= 1));
  await fs.rm(dir, { recursive: true, force: true });
});

test('el compresor de video delega en el de audio cuando no hay imagen', async () => {
  const dir = await tmpDir();
  const input = path.join(dir, 'solo.mp4');
  makeAudio(input, { codecArgs: ['-c:a', 'aac', '-b:a', '320k'] });
  const report = await optimizeVideo(input, path.join(dir, 'out', 'solo.mp4'), { quality: 90 });
  assert.equal(path.extname(report.output), '.m4a');
  assert.equal(report.skipped, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('(auxiliar) run() falla con un mensaje util si ffmpeg rechaza los argumentos', () => {
  assert.throws(() => run(['-i', '/no/existe.wav', '/tmp/x.mp3']), /ffmpeg fallo/);
});
