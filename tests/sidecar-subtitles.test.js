'use strict';

// Subtitulos en archivo aparte: viajan con su video (importacion de carpetas,
// sueltos y comprimidos) y se copian a la salida con el nombre de la salida.

const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.COMPACTA_TEST_BASE_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'compacta-sc-base-'));

const { importPaths } = require('../src/main/importer');
const { processMedia } = require('../src/main/processor');
const { isSidecarOf, sidecarSuffix, isSubtitleFile } = require('../src/main/processor/formats');
const { makeVideo, makeVideoWithSubtitles } = require('./helpers/make-video');
const { makeZip } = require('./helpers/make-zip');
const { makeArchive, TOOLS } = require('./helpers/make-archive');
const { findTarBinary } = require('../src/main/system-archive');

const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), `compacta-sc-${p}-`));
const SRT = '1\n00:00:00,000 --> 00:00:01,000\nHola\n';
const names = async (dir) => (await fs.readdir(dir)).filter((n) => !n.includes('.tmp-')).sort();

// Esta prueba no es sobre duplicados: importa a proposito el mismo archivo
// sintetico una y otra vez. La deteccion se prueba en duplicates.test.js.
require('../src/main/settings-store').saveSettings({ skipDuplicates: false });

test('reglas de emparejado: mismo nombre, con o sin etiqueta; "Peli 2" no es de "Peli"', () => {
  assert.ok(isSidecarOf('Peli.srt', 'Peli.mkv'));
  assert.ok(isSidecarOf('PELI.ES.SRT', 'peli.mp4'), 'sin importar mayusculas');
  assert.ok(isSidecarOf('Peli.spa.forced.srt', 'Peli.mkv'));
  assert.ok(isSidecarOf('Show.S01E01.en.ass', 'Show.S01E01.mkv'));
  assert.ok(!isSidecarOf('Peli 2.srt', 'Peli.mkv'));
  assert.ok(!isSidecarOf('Peli2.srt', 'Peli.mkv'));
  assert.ok(!isSidecarOf('Peli.txt', 'Peli.mkv'), 'solo extensiones de subtitulo');
  assert.ok(!isSidecarOf('Peli.srt', 'Peli.jpg'), 'solo acompanan a videos');
  assert.ok(!isSidecarOf('._Peli.srt', 'Peli.mkv'), 'basura de macOS');
  assert.ok(isSidecarOf('Canci\u00f3n.srt', 'Cancio\u0301n.mp4'), 'NFC y NFD son el mismo nombre (macOS)');
  assert.equal(sidecarSuffix('Canci\u00f3n.es.srt', 'Cancio\u0301n.mp4'), '.es.srt', 'el corte no se desplaza por la forma Unicode');
  assert.equal(sidecarSuffix('PELI.ES.SRT', 'peli.mp4'), '.ES.SRT', 'conserva las mayusculas del original');
  assert.ok(isSubtitleFile('x.vtt') && isSubtitleFile('x.idx') && !isSubtitleFile('x.jpg'));
});

test('carpeta: el video entra con sus subtitulos; un subtitulo huerfano o de otra pelicula cuenta como no compatible', async () => {
  const src = await tmp('folder');
  await fs.mkdir(path.join(src, 'Pelis'));
  makeVideo(path.join(src, 'Pelis', 'Peli.mkv'), { seconds: 1 });
  for (const n of ['Peli.srt', 'Peli.es.srt', 'Suelto.srt', 'Peli 2.srt']) await fs.writeFile(path.join(src, 'Pelis', n), SRT);

  const result = await importPaths([path.join(src, 'Pelis')]);

  assert.equal(result.importedFiles.length, 1, 'solo el video entra en la cola');
  const dir = path.dirname(result.importedFiles[0]);
  assert.deepEqual(await names(dir), ['Peli.es.srt', 'Peli.mkv', 'Peli.srt'], 'sus dos subtitulos viajan con el');
  assert.equal(result.skippedCount, 2, 'Suelto.srt y "Peli 2.srt" no acompanan a nada');
  await fs.rm(src, { recursive: true, force: true });
});

test('video SUELTO: arrastrar solo el video trae tambien su subtitulo de la carpeta de origen', async () => {
  const src = await tmp('loose');
  makeVideo(path.join(src, 'Solo.mp4'), { seconds: 1 });
  await fs.writeFile(path.join(src, 'Solo.srt'), SRT);
  await fs.writeFile(path.join(src, 'Otro.srt'), SRT);

  const result = await importPaths([path.join(src, 'Solo.mp4')]);

  assert.equal(result.importedFiles.length, 1);
  assert.deepEqual(await names(path.dirname(result.importedFiles[0])), ['Solo.mp4', 'Solo.srt']);
  assert.equal(result.skippedCount, 0, 'Otro.srt ni se mira: no se arrastro');
  await fs.rm(src, { recursive: true, force: true });
});

test('dos videos sueltos con el mismo nombre: el segundo se renombra Y su subtitulo con el', async () => {
  const src = await tmp('collide');
  for (const d of ['a', 'b']) {
    await fs.mkdir(path.join(src, d));
    makeVideo(path.join(src, d, 'Clip.mp4'), { seconds: 1 });
    await fs.writeFile(path.join(src, d, 'Clip.es.srt'), `${SRT}${d}`);
  }

  const result = await importPaths([path.join(src, 'a', 'Clip.mp4'), path.join(src, 'b', 'Clip.mp4')]);

  assert.equal(result.importedFiles.length, 2);
  assert.deepEqual(await names(path.dirname(result.importedFiles[0])), ['Clip (2).es.srt', 'Clip (2).mp4', 'Clip.es.srt', 'Clip.mp4']);
  assert.match(await fs.readFile(path.join(path.dirname(result.importedFiles[0]), 'Clip (2).es.srt'), 'utf8'), /b$/, 'el subtitulo de "b" va con el video de "b"');
  await fs.rm(src, { recursive: true, force: true });
});

test('video y subtitulo arrastrados juntos desde sitios distintos se emparejan; un subtitulo solo, no', async () => {
  const a = await tmp('dropA');
  const b = await tmp('dropB');
  makeVideo(path.join(a, 'Peli.mp4'), { seconds: 1 });
  await fs.writeFile(path.join(b, 'Peli.srt'), SRT);
  await fs.writeFile(path.join(b, 'Nada.srt'), SRT);

  const result = await importPaths([path.join(a, 'Peli.mp4'), path.join(b, 'Peli.srt'), path.join(b, 'Nada.srt')]);

  assert.deepEqual(await names(path.dirname(result.importedFiles[0])), ['Peli.mp4', 'Peli.srt']);
  assert.equal(result.skippedCount, 1, 'Nada.srt');

  const alone = await importPaths([path.join(b, 'Nada.srt')]);
  assert.equal(alone.importedFiles.length, 0);
  assert.equal(alone.skippedCount, 1);
  await fs.rm(a, { recursive: true, force: true });
  await fs.rm(b, { recursive: true, force: true });
});

test('ZIP: el subtitulo de un video se conserva aunque llegue ANTES que el video; el huerfano se elimina', async () => {
  const src = await tmp('zip');
  const clip = path.join(src, 'c.mp4');
  makeVideo(clip, { seconds: 1 });
  const zipPath = path.join(src, 'Pack.zip');
  await fs.writeFile(zipPath, makeZip([
    { name: 'T/Peli.es.srt', data: SRT }, // antes que su video
    { name: 'T/Peli.mp4', data: await fs.readFile(clip) },
    { name: 'T/Huerfano.srt', data: SRT }
  ]));

  const result = await importPaths([zipPath]);

  assert.equal(result.importedFiles.length, 1);
  assert.deepEqual(await names(path.dirname(result.importedFiles[0])), ['Peli.es.srt', 'Peli.mp4']);
  assert.equal(result.skippedCount, 1, 'el huerfano se cuenta y no queda en disco');
  await fs.rm(src, { recursive: true, force: true });
});

test('comprimido tar.gz (tar del sistema): igual que el ZIP', async (t) => {
  if (!findTarBinary() || !TOOLS.tar) return t.skip('sin tar');
  const src = await tmp('tgz');
  await fs.mkdir(path.join(src, 'in'));
  makeVideo(path.join(src, 'in', 'Peli.mp4'), { seconds: 1 });
  await fs.writeFile(path.join(src, 'in', 'Peli.srt'), SRT);
  await fs.writeFile(path.join(src, 'in', 'Huerfano.srt'), SRT);
  const archive = path.join(src, 'PackTgz.tar.gz'); // nombre propio: con el mismo nombre que el .zip de arriba se UNIRIA a su carpeta
  assert.ok(makeArchive('tgz', path.join(src, 'in'), archive));

  const result = await importPaths([archive]);

  assert.equal(result.importedFiles.length, 1);
  assert.deepEqual(await names(path.dirname(result.importedFiles[0])), ['Peli.mp4', 'Peli.srt']);
  assert.equal(result.skippedCount, 1);
  await fs.rm(src, { recursive: true, force: true });
});

// ---------------------------------------------------------------- salida
test('al comprimir, los subtitulos se copian a la salida con el nombre del video de SALIDA', async () => {
  const dir = await tmp('proc');
  makeVideo(path.join(dir, 'Peli.mov'), { seconds: 3 });
  await fs.writeFile(path.join(dir, 'Peli.srt'), SRT);
  await fs.writeFile(path.join(dir, 'Peli.es.forced.srt'), SRT);
  await fs.writeFile(path.join(dir, 'Otra.srt'), SRT);

  const report = await processMedia(path.join(dir, 'Peli.mov'), path.join(dir, 'out', 'Peli.mov'), { quality: 90 });

  assert.ok(report.output.endsWith('Peli.mp4'), 'el .mov sale .mp4');
  assert.equal(report.sidecarCount, 2);
  assert.deepEqual(await names(path.join(dir, 'out')), ['Peli.es.forced.srt', 'Peli.mp4', 'Peli.srt'], 'siguen llamandose como el video: el reproductor los encuentra solo');
  assert.equal(await fs.readFile(path.join(dir, 'out', 'Peli.srt'), 'utf8'), SRT);
  await fs.rm(dir, { recursive: true, force: true });
});

test('video que sale .mkv (por sus subtitulos internos): el subtitulo externo toma el nombre .mkv', async () => {
  const dir = await tmp('procmkv');
  makeVideoWithSubtitles(path.join(dir, 'Serie.mkv'), 'mkv-ass-srt');
  await fs.writeFile(path.join(dir, 'Serie.en.srt'), SRT);

  const report = await processMedia(path.join(dir, 'Serie.mkv'), path.join(dir, 'out', 'Serie.mkv'), { quality: 90 });

  assert.ok(report.output.endsWith('.mkv'));
  assert.deepEqual(await names(path.join(dir, 'out')), ['Serie.en.srt', 'Serie.mkv']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('video ya muy comprimido (se deja intacto): su subtitulo tambien viaja, con el nombre de la copia', async () => {
  const dir = await tmp('procskip');
  makeVideo(path.join(dir, 'Ligero.mp4'), { seconds: 2, crf: 40, audio: null });
  await fs.writeFile(path.join(dir, 'Ligero.srt'), SRT);

  const report = await processMedia(path.join(dir, 'Ligero.mp4'), path.join(dir, 'out', 'Ligero.mp4'), { quality: 90 });

  assert.equal(report.skipped, true);
  assert.deepEqual(await names(path.join(dir, 'out')), ['Ligero.mp4', 'Ligero.srt']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('un video sin subtitulos no cambia en nada (sidecarCount 0, nada extra en la salida)', async () => {
  const dir = await tmp('procnone');
  makeVideo(path.join(dir, 'Normal.mp4'), { seconds: 2 });
  const report = await processMedia(path.join(dir, 'Normal.mp4'), path.join(dir, 'out', 'Normal.mp4'), { quality: 90 });
  assert.equal(report.sidecarCount, 0);
  assert.deepEqual(await names(path.join(dir, 'out')), ['Normal.mp4']);
  await fs.rm(dir, { recursive: true, force: true });
});
