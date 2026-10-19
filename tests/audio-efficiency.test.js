'use strict';

// Pruebas de lo que hace que el audio pese poco SIN perder calidad (ver 7.19 de la documentacion):
// estereo que en realidad es mono, modo voz, formatos Opus y FLAC, portadas y la red de seguridad.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeAudio, run } = require('./helpers/make-audio');
const {
  optimizeAudio, planAudio, buildAudioArgs, buildTrialArgs, planCoverOnly, buildCoverOnlyArgs, coverNeedsShrink,
  mp3VoiceLevel, expectedKbps, isCompleteOutput, trialCanChangeDecision
} = require('../src/main/processor/audio-optimizer');
const { sampleWindows, stereoEnergies, decideChannels } = require('../src/main/processor/audio-analysis');
const { probeVideo, getFfmpegPath } = require('../src/main/processor/ffmpeg');
const { loadSettings, saveSettings, createProfile } = require('../src/main/settings-store');

const stereoProbe = { durationSec: 4, hasVideo: false, hasCover: false, cover: null, bitrateKbps: 0, audio: [{ codec: 'mp3', channels: 2, sampleRate: 44100, bitrateKbps: 192 }], subtitles: [] };
const wavProbe = { ...stereoProbe, audio: [{ codec: 'pcm_s16le', channels: 2, sampleRate: 44100, bitrateKbps: 1411 }] };
const plan = (probe, options = {}, analysis = {}, input = '/x/a.mp3') => planAudio(probe, { quality: 90, ...options }, input, 700000, undefined, analysis);

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'compacta-aeff-'));
}

const md5 = (file, extra = ['-map', '0:a', '-c', 'copy']) => spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', file, ...extra, '-f', 'md5', '-'], { encoding: 'utf8' }).stdout.trim();
const pcmMd5 = (file) => md5(file, ['-map', '0:a:0', '-f', 's16le', '-c:a', 'pcm_s16le']).replace(/^MD5=/, '');

// ------------------------------------------------------------------ analisis de canales (puro)

test('muestras: corto entero, medio en dos trozos, largo en tres; la prueba de peso usa trozos mas cortos', () => {
  assert.equal(sampleWindows(10).length, 1);
  assert.equal(sampleWindows(0).length, 1);
  assert.equal(sampleWindows(240).length, 2, 'una cancion: dos trozos');
  assert.equal(sampleWindows(240)[0].length, 15);
  assert.ok(sampleWindows(240, 10).every((x) => x.length === 10), 'trozos cortos para la prueba');
  assert.equal(sampleWindows(20, 10)[0].length, 10);
  const w = sampleWindows(3600);
  assert.equal(w.length, 3);
  assert.ok(w[0].start < w[1].start && w[1].start < w[2].start);
  assert.ok(w.every((x) => x.start + x.length <= 3600), 'ninguna se sale del archivo');
});

test('energias estereo: dos canales iguales no tienen lateral; uno vacio si', () => {
  const frames = 4000;
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(8000 * Math.sin(i / 7));
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  const same = stereoEnergies(pcm);
  assert.ok(same.side < same.mid * 1e-9, 'sin canal lateral');
  const left = Buffer.from(pcm);
  for (let i = 0; i < frames; i++) left.writeInt16LE(0, i * 4 + 2);
  const one = stereoEnergies(left);
  assert.equal(one.right, 0);
  assert.ok(one.left > 0);
});

test('decision de canales: mono solo si TODOS los trozos con sonido lo son; el peor manda', () => {
  const win = (left, right, mid, side) => ({ left, right, mid, side });
  const dual = win(0.01, 0.01, 0.01, 1e-9);        // lateral -70 dB
  const wide = win(0.01, 0.01, 0.006, 0.004);      // lateral -1,8 dB: estereo de verdad
  assert.equal(decideChannels([dual, dual, dual], -32).mode, 'mix');
  assert.equal(decideChannels([dual, wide, dual], -32).mode, 'stereo', 'un solo trozo estereo basta para no tocar nada');
  assert.equal(decideChannels([win(0.01, 1e-12, 0.0025, 0.0025)], -32).mode, 'left', 'canal derecho vacio');
  assert.equal(decideChannels([win(1e-12, 0.01, 0.0025, 0.0025)], -32).mode, 'right');
  assert.equal(decideChannels([win(1e-12, 1e-12, 0, 0)], -32).mode, 'stereo', 'silencio total: no se toca');
  assert.equal(decideChannels([], -32).mode, 'stereo');
  // El umbral de voz es mas relajado que el de musica.
  const near = win(0.01, 0.01, 0.0098, 0.0002);    // lateral ~ -17 dB
  assert.equal(decideChannels([near], -32).mode, 'stereo');
  assert.equal(decideChannels([near], -15).mode, 'mix');
});

// ------------------------------------------------------------------ planes (puros)

test('mono medido: el plan guarda un solo canal y lo expresa en el filtro de ffmpeg', () => {
  const p = plan(wavProbe, {}, { channelMode: 'mix' }, '/x/a.wav');
  assert.equal(p.outChannels, 1);
  const args = buildAudioArgs(p, 'in.wav', 'out.tmp');
  assert.equal(args[args.indexOf('-af') + 1], 'pan=mono|c0=0.5*c0+0.5*c1');
  assert.equal(buildAudioArgs(plan(wavProbe, {}, { channelMode: 'left' }, '/x/a.wav'), 'a', 'b').join(' ').includes('pan=mono|c0=c0'), true);
  assert.equal(buildAudioArgs(plan(wavProbe, {}, { channelMode: 'right' }, '/x/a.wav'), 'a', 'b').join(' ').includes('pan=mono|c0=c1'), true);
  assert.equal(buildAudioArgs(plan(wavProbe, {}, {}, '/x/a.wav'), 'a', 'b').includes('-af'), false, 'sin medicion no se toca nada');
});

test('con varias pistas o mas de 2 canales no se baja a mono aunque se pida', () => {
  const multi = { ...wavProbe, audio: [wavProbe.audio[0], wavProbe.audio[0]] };
  assert.equal(plan(multi, {}, { channelMode: 'mix' }, '/x/a.mka').channelMode, 'stereo');
  const six = { ...wavProbe, audio: [{ codec: 'flac', channels: 6, sampleRate: 48000, bitrateKbps: 3000 }] };
  assert.equal(plan(six, {}, { channelMode: 'mix' }, '/x/a.flac').channelMode, 'stereo');
});

test('modo voz: MP3 mas bajo, 22 kHz solo con calidad baja, y los codecs de solo voz lo activan solos', () => {
  assert.ok(mp3VoiceLevel(90) > 2 && mp3VoiceLevel(90) === 4, '90 -> V4');
  assert.ok(mp3VoiceLevel(100) < mp3VoiceLevel(90) && mp3VoiceLevel(60) > mp3VoiceLevel(90));
  const music = plan(wavProbe, {}, { channelMode: 'mix' }, '/x/a.wav');
  const voice = plan(wavProbe, { audioKind: 'voice' }, { channelMode: 'mix' }, '/x/a.wav');
  assert.equal(voice.voice, true);
  assert.equal(music.voice, false);
  assert.equal(buildAudioArgs(voice, 'a', 'b')[buildAudioArgs(voice, 'a', 'b').indexOf('-q:a') + 1], '4');
  assert.equal(buildAudioArgs(music, 'a', 'b')[buildAudioArgs(music, 'a', 'b').indexOf('-q:a') + 1], '2');
  assert.equal(voice.sampleRate, null, 'a 90 se conserva la frecuencia');
  assert.equal(plan(wavProbe, { audioKind: 'voice', quality: 75 }, { channelMode: 'mix' }, '/x/a.wav').sampleRate, 22050);
  assert.ok(expectedKbps('mp3', 90, 1, true) < expectedKbps('mp3', 90, 1, false), 'la voz pesa menos');
  const amr = { ...stereoProbe, audio: [{ codec: 'amr_nb', channels: 1, sampleRate: 8000, bitrateKbps: 12 }] };
  assert.equal(plan(amr, {}, {}, '/x/a.amr').voice, true, 'AMR solo existe para voz');
  assert.equal(plan(stereoProbe, {}, {}, '/x/a.mp3').voice, false, 'un MP3 normal NUNCA se adivina como voz');
});

test('recodificar un audio con perdida solo compensa si la prueba real ahorra un 20 % o mas', () => {
  assert.equal(plan(stereoProbe, {}, { projectedKbps: 170 }).skip, 'ya-optimizado', '11 % de ahorro: no compensa');
  assert.equal(plan(stereoProbe, {}, { projectedKbps: 150 }).skip, null, '22 % de ahorro: si');
  assert.equal(plan(wavProbe, {}, { projectedKbps: 999 }, '/x/a.wav').skip, null, 'lo sin perdida siempre se recodifica');
});

test('formatos de salida: Opus para todo (menos 5.1), FLAC solo para lo sin perdida y sin tocar nada', () => {
  assert.equal(plan(stereoProbe, { audioFormat: 'opus' }).family, 'opus');
  assert.equal(plan(wavProbe, { audioFormat: 'opus' }, {}, '/x/a.wav').extension, '.opus');
  const six = { ...wavProbe, audio: [{ codec: 'flac', channels: 6, sampleRate: 48000, bitrateKbps: 3000 }] };
  assert.equal(plan(six, { audioFormat: 'opus' }, {}, '/x/a.flac').family, 'aac', '5.1 no va a Opus');

  const flac = plan(wavProbe, { audioFormat: 'flac' }, { channelMode: 'mix' }, '/x/a.wav');
  assert.equal(flac.family, 'flac');
  assert.equal(flac.extension, '.flac');
  assert.equal(flac.channelMode, 'stereo', 'sin perdida: no se cambian los canales');
  assert.equal(flac.sampleRate, null, 'ni la frecuencia');
  assert.equal(flac.wantsChannelAnalysis, false);
  const args = buildAudioArgs(flac, 'in.wav', 'out');
  assert.ok(args.includes('flac') && !args.includes('-af') && !args.includes('-ar'));
  assert.equal(plan({ ...wavProbe, audio: [{ ...wavProbe.audio[0], codec: 'flac' }] }, { audioFormat: 'flac' }, {}, '/x/a.flac').skip, 'ya-optimizado', 'FLAC a FLAC no se repite');
  assert.equal(plan(stereoProbe, { audioFormat: 'flac' }).family, 'mp3', 'lo que ya tiene perdida nunca va a FLAC (pesaria mas)');
  const dsd = { ...wavProbe, audio: [{ codec: 'dsd_lsbf', channels: 2, sampleRate: 2822400, bitrateKbps: 5644 }] };
  assert.notEqual(plan(dsd, { audioFormat: 'flac' }, {}, '/x/a.dsf').family, 'flac', 'el DSD no cabe en FLAC');
  const float = { ...wavProbe, audio: [{ codec: 'pcm_f32le', channels: 2, sampleRate: 48000, bitrateKbps: 3072 }] };
  const floatArgs = buildAudioArgs(plan(float, { audioFormat: 'flac' }, {}, '/x/a.wav'), 'a', 'b');
  assert.ok(floatArgs.includes('s32') && floatArgs.includes('24'), 'float -> 24 bits');
  assert.equal(buildAudioArgs(plan(wavProbe, { audioFormat: 'flac', maxCompression: true }, {}, '/x/a.wav'), 'a', 'b')[buildAudioArgs(plan(wavProbe, { audioFormat: 'flac', maxCompression: true }, {}, '/x/a.wav'), 'a', 'b').indexOf('-compression_level') + 1], '12');
  // Sin el codificador FLAC en ese ffmpeg se vuelve al camino normal en vez de fallar.
  assert.notEqual(planAudio(wavProbe, { quality: 90, audioFormat: 'flac' }, '/x/a.wav', 7e5, new Set(['libmp3lame', 'aac'])).family, 'flac');
});

test('portadas: se reducen solo si pesan de mas, nunca con -frames:v (cortaba el audio)', () => {
  assert.equal(coverNeedsShrink({ codec: 'mjpeg', width: 3000, height: 3000 }), true);
  assert.equal(coverNeedsShrink({ codec: 'mjpeg', width: 600, height: 600 }), false);
  assert.equal(coverNeedsShrink({ codec: 'png', width: 300, height: 300 }), true, 'PNG pesa mucho mas que JPEG');
  assert.equal(coverNeedsShrink(null), false);
  const withBig = { ...wavProbe, hasCover: true, cover: { codec: 'mjpeg', width: 2400, height: 2400 } };
  const args = buildAudioArgs(plan(withBig, {}, {}, '/x/a.wav'), 'in.wav', 'out');
  assert.equal(args[args.indexOf('-c:v') + 1], 'mjpeg');
  assert.ok(args.some((a) => /scale='min\(600,iw\)'/.test(a)));
  assert.ok(!args.includes('-frames:v'), '-frames:v 1 hace que ffmpeg deje de escribir tras la portada');
  const small = { ...wavProbe, hasCover: true, cover: { codec: 'mjpeg', width: 500, height: 500 } };
  assert.equal(buildAudioArgs(plan(small, {}, {}, '/x/a.wav'), 'in.wav', 'out')[buildAudioArgs(plan(small, {}, {}, '/x/a.wav'), 'in.wav', 'out').indexOf('-c:v') + 1], 'copy');
});

test('solo cambiar la portada (copiando el audio) se ofrece unicamente donde es seguro', () => {
  const big = { codec: 'mjpeg', width: 3000, height: 3000 };
  const mp3 = { ...stereoProbe, hasCover: true, cover: big };
  assert.ok(planCoverOnly(mp3, '/x/a.mp3'));
  assert.equal(planCoverOnly(mp3, '/x/a.MP3').format, 'mp3', 'mayusculas');
  assert.equal(planCoverOnly({ ...mp3, audio: [{ ...mp3.audio[0], codec: 'aac' }] }, '/x/a.m4a').format, 'ipod');
  assert.equal(planCoverOnly({ ...mp3, audio: [{ ...mp3.audio[0], codec: 'aac' }] }, '/x/a.aac'), null, 'AAC suelto (ADTS) no');
  assert.equal(planCoverOnly({ ...mp3, audio: [{ ...mp3.audio[0], codec: 'vorbis' }] }, '/x/a.ogg'), null);
  assert.equal(planCoverOnly({ ...mp3, cover: { codec: 'mjpeg', width: 500, height: 500 } }, '/x/a.mp3'), null, 'portada ya ligera');
  assert.equal(planCoverOnly({ ...stereoProbe }, '/x/a.mp3'), null, 'sin portada');
  const args = buildCoverOnlyArgs(planCoverOnly(mp3, '/x/a.mp3'), 'in.mp3', 'out');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
  assert.ok(!args.includes('-frames:v'));
});

test('la prueba de peso solo se hace cuando puede cambiar la decision (lanzar ffmpeg cuesta)', () => {
  const src = (kbps) => ({ ...stereoProbe, audio: [{ ...stereoProbe.audio[0], bitrateKbps: kbps }] });
  assert.equal(trialCanChangeDecision(plan(src(128)), src(128), 1), false, '128k de musica estereo: ni con sonido facil llegaria al 20 %');
  assert.equal(trialCanChangeDecision(plan(src(192)), src(192), 1), true, '192k: depende del sonido');
  assert.equal(trialCanChangeDecision(plan(src(128), {}, { channelMode: 'mix' }), src(128), 1), true, 'en mono si puede compensar');
  const unknown = { ...src(0), durationSec: 0 };
  assert.equal(trialCanChangeDecision(plan(unknown), unknown, 1), true, 'sin saber la tasa de origen, se mide');
});

test('la prueba de peso lee un trozo, no escribe archivos y usa los mismos ajustes que el real', () => {
  const p = plan(wavProbe, { audioKind: 'voice' }, { channelMode: 'mix' }, '/x/a.wav');
  const args = buildTrialArgs(p, 'in.wav', { start: 10, length: 12 });
  assert.deepEqual(args.slice(0, 4), ['-ss', '10', '-t', '12']);
  assert.equal(args[args.length - 1], 'pipe:1');
  assert.ok(args.join(' ').includes('libmp3lame') && args.join(' ').includes('pan=mono'));
});

// ------------------------------------------------------------------ ajustes

test('ajustes de audio: solo valores validos, y viajan en los perfiles', () => {
  const dir = path.join(os.tmpdir(), `compacta-aset-${process.pid}`);
  process.env.COMPACTA_TEST_BASE_DIR = dir;
  try {
    assert.equal(loadSettings().audioKind, 'music');
    assert.equal(loadSettings().audioFormat, 'compat');
    saveSettings({ audioKind: 'voice', audioFormat: 'opus' });
    assert.equal(loadSettings().audioKind, 'voice');
    assert.equal(loadSettings().audioFormat, 'opus');
    saveSettings({ audioKind: 'hack', audioFormat: '../../x' });
    assert.equal(loadSettings().audioKind, 'voice', 'un valor raro no pisa el bueno');
    assert.equal(loadSettings().audioFormat, 'opus');
    const next = createProfile('Predicaciones', { audioKind: 'voice', audioFormat: 'compat' });
    const profile = next.profiles.find((p) => p.name === 'Predicaciones');
    assert.equal(profile.audioKind, 'voice');
    assert.equal(profile.audioFormat, 'compat');
  } finally {
    delete process.env.COMPACTA_TEST_BASE_DIR;
  }
});

// ------------------------------------------------------------------ audios REALES

test('REAL: una predicacion en estereo duplicado (MP3 192k) se guarda en mono y pesa mucho menos', async () => {
  const dir = await tmpDir();
  const input = path.join(dir, 'predicacion.mp3');
  makeAudio(input, { seconds: 8, dualMono: true, codecArgs: ['-c:a', 'libmp3lame', '-b:a', '192k'] });
  const report = await optimizeAudio(input, path.join(dir, 'out', 'predicacion.mp3'), { quality: 90 });
  assert.equal(report.skipped, false);
  assert.equal(report.detail, 'mono');
  assert.ok(report.newBytes < report.originalBytes * 0.6, `${report.originalBytes} -> ${report.newBytes}`);
  const probe = await probeVideo(report.output);
  assert.equal(probe.audio[0].channels, 1);
  assert.ok(Math.abs(probe.durationSec - 8) < 0.3, 'dura lo mismo');
  await fs.rm(dir, { recursive: true, force: true });
});

test('REAL: un estereo de verdad NO se toca ni se baja a mono (la musica no se degrada)', async () => {
  const dir = await tmpDir();
  const input = path.join(dir, 'musica.mp3');
  makeAudio(input, { seconds: 8, codecArgs: ['-c:a', 'libmp3lame', '-b:a', '128k'] });
  const report = await optimizeAudio(input, path.join(dir, 'out', 'musica.mp3'), { quality: 90 });
  assert.equal(report.skipped, true);
  assert.equal(report.reason, 'ya-optimizado');
  assert.equal(md5(report.output), md5(input), 'copia identica');
  await fs.rm(dir, { recursive: true, force: true });
});

test('REAL: un canal vacio (grabado solo por la izquierda) se guarda en mono con lo que suena', async () => {
  const dir = await tmpDir();
  const input = path.join(dir, 'izq.wav');
  makeAudio(input, { seconds: 4, codecArgs: ['-af', 'pan=stereo|c0=c0|c1=0*c0', '-c:a', 'pcm_s16le'] });
  const report = await optimizeAudio(input, path.join(dir, 'out', 'izq.wav'), { quality: 90 });
  assert.equal(report.detail, 'mono');
  assert.equal((await probeVideo(report.output)).audio[0].channels, 1);
  // Y suena (no se quedo con el canal vacio): la energia de la salida no es cero.
  const vol = spawnSync(getFfmpegPath(), ['-hide_banner', '-i', report.output, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  assert.ok(/mean_volume: -\d+(\.\d+)? dB/.test(vol) && !/mean_volume: -9\d/.test(vol), vol.split('\n').filter((l) => /mean_volume/.test(l)).join(''));
  await fs.rm(dir, { recursive: true, force: true });
});

test('REAL: modo voz pesa menos que el modo musica con la misma predicacion', async () => {
  const dir = await tmpDir();
  const input = path.join(dir, 'p.wav');
  makeAudio(input, { seconds: 8, dualMono: true, codecArgs: ['-c:a', 'pcm_s16le'] });
  const music = await optimizeAudio(input, path.join(dir, 'm', 'p.wav'), { quality: 90 });
  const voice = await optimizeAudio(input, path.join(dir, 'v', 'p.wav'), { quality: 90, audioKind: 'voice' });
  assert.ok(voice.newBytes < music.newBytes, `voz ${voice.newBytes} < musica ${music.newBytes}`);
  assert.match(voice.detail, /voz/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('REAL: Opus de salida (musica y voz) se decodifica entero y dura lo mismo', async () => {
  const dir = await tmpDir();
  const input = path.join(dir, 'c.wav');
  makeAudio(input, { seconds: 6, codecArgs: ['-c:a', 'pcm_s16le'] });
  const report = await optimizeAudio(input, path.join(dir, 'out', 'c.wav'), { quality: 90, audioFormat: 'opus' });
  assert.equal(path.extname(report.output), '.opus');
  const probe = await probeVideo(report.output);
  assert.equal(probe.audio[0].codec, 'opus');
  assert.ok(Math.abs(probe.durationSec - 6) < 0.3);
  const decode = spawnSync(getFfmpegPath(), ['-hide_banner', '-v', 'error', '-i', report.output, '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal(decode.stderr.trim(), '', 'sin errores al decodificar');
  const voice = await optimizeAudio(input, path.join(dir, 'outv', 'c.wav'), { quality: 90, audioFormat: 'opus', audioKind: 'voice' });
  assert.ok(voice.newBytes < report.newBytes, 'Opus de voz pesa menos');
  await fs.rm(dir, { recursive: true, force: true });
});

test('REAL: FLAC es bit a bit identico al original (WAV 16 y 24 bits, mono y estereo)', async () => {
  const dir = await tmpDir();
  for (const [name, args, channels] of [['s16.wav', ['-c:a', 'pcm_s16le'], 2], ['s24.wav', ['-c:a', 'pcm_s24le'], 2], ['mono.wav', ['-c:a', 'pcm_s16le'], 1]]) {
    const input = path.join(dir, name);
    makeAudio(input, { seconds: 4, channels, codecArgs: args });
    const report = await optimizeAudio(input, path.join(dir, 'out', name), { quality: 90, audioFormat: 'flac' });
    assert.equal(report.skipped, false, name);
    assert.equal(path.extname(report.output), '.flac');
    assert.ok(report.newBytes < report.originalBytes * 0.8, `${name}: ${report.originalBytes} -> ${report.newBytes}`);
    const fmt = name.startsWith('s24') ? ['-c:a', 'pcm_s24le'] : ['-c:a', 'pcm_s16le'];
    const raw = (f) => spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', f, '-map', '0:a:0', ...fmt, '-f', 'md5', '-'], { encoding: 'utf8' }).stdout;
    assert.equal(raw(report.output), raw(input), `${name}: las muestras son identicas`);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('REAL: portada gigante en un MP3 ya optimo: el audio no se toca (mismo MD5), la portada baja a 600 px y las etiquetas siguen', async () => {
  const dir = await tmpDir();
  const cover = path.join(dir, 'cover.jpg');
  run(['-f', 'lavfi', '-i', 'mandelbrot=size=2000x2000:rate=1', '-frames:v', '1', '-q:v', '2', cover]);
  const input = path.join(dir, 'tema.mp3');
  // Ruido rosa: dificil de comprimir, asi que 64 kbps ya es lo minimo razonable (un tono puro se reduciria aun mas).
  run(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.3:duration=6:sample_rate=44100', '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-b:a', '64k', '-c:v', 'copy',
    '-id3v2_version', '3', '-disposition:v', 'attached_pic', '-metadata', 'title=Mi tema', '-metadata', 'artist=Grupo', input]);
  const before = await fs.stat(input);
  const report = await optimizeAudio(input, path.join(dir, 'out', 'tema.mp3'), { quality: 90 });
  assert.equal(report.skipped, false);
  assert.equal(report.detail, 'portada reducida');
  assert.ok(report.newBytes < before.size * 0.5, `${before.size} -> ${report.newBytes}`);
  assert.equal(md5(report.output), md5(input), 'el audio es EXACTAMENTE el mismo');
  const out = await probeVideo(report.output);
  assert.equal(out.cover.width, 600);
  assert.ok(Math.abs(out.durationSec - 6) < 0.2, 'no se perdio audio');
  const tags = spawnSync(getFfmpegPath(), ['-hide_banner', '-i', report.output], { encoding: 'utf8' }).stderr;
  assert.match(tags, /Mi tema/);
  assert.match(tags, /Grupo/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('REAL: la portada gigante tambien se reduce al recodificar un WAV', async () => {
  const dir = await tmpDir();
  const cover = path.join(dir, 'cover.jpg');
  run(['-f', 'lavfi', '-i', 'mandelbrot=size=1800x1800:rate=1', '-frames:v', '1', '-q:v', '2', cover]);
  const input = path.join(dir, 'tema.flac');
  run(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'flac', '-c:v', 'copy', '-disposition:v', 'attached_pic', input]);
  const report = await optimizeAudio(input, path.join(dir, 'out', 'tema.flac'), { quality: 90 });
  const out = await probeVideo(report.output);
  assert.ok(out.hasCover && out.cover.width <= 600, JSON.stringify(out.cover));
  assert.ok(Math.abs(out.durationSec - 4) < 0.2);
  await fs.rm(dir, { recursive: true, force: true });
});

test('red de seguridad: una salida truncada se detecta (no falta musica) y una completa se acepta', async () => {
  const dir = await tmpDir();
  const full = path.join(dir, 'full.mp3');
  makeAudio(full, { seconds: 8, codecArgs: ['-c:a', 'libmp3lame', '-b:a', '128k'] });
  const cut = path.join(dir, 'cut.mp3');
  run(['-i', full, '-t', '2', '-c', 'copy', cut]);
  assert.equal(await isCompleteOutput(full, 8), true);
  assert.equal(await isCompleteOutput(cut, 8), false, '2 s de 8: truncada');
  assert.equal(await isCompleteOutput(path.join(dir, 'no-existe.mp3'), 8), false);
  assert.equal(await isCompleteOutput(full, 0), true, 'sin duracion conocida no se puede comparar');
  await fs.rm(dir, { recursive: true, force: true });
});
