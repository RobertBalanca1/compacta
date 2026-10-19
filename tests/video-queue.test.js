'use strict';

// La cola con videos: carril propio de un solo worker, avance real, y sin
// bloquear a las fotos (ni al reves).

const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.COMPACTA_TEST_BASE_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'compacta-vq-base-'));

const sharp = require('sharp');
const { QueueManager } = require('../src/main/queue-manager');
const { makeVideo } = require('./helpers/make-video');
const { importPaths } = require('../src/main/importer');
const { makeZip } = require('./helpers/make-zip');
const { isSupportedMedia, mediaKind, candidateOutputFileNames } = require('../src/main/processor/formats');

function waitFor(qm, event) {
  return new Promise((resolve) => qm.once(event, resolve));
}

async function makePhoto(file) {
  await sharp({ create: { width: 400, height: 300, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 40 } } }).jpeg({ quality: 97 }).toFile(file);
}

// Esta prueba no es sobre duplicados: importa a proposito el mismo archivo
// sintetico una y otra vez. La deteccion se prueba en duplicates.test.js.
require('../src/main/settings-store').saveSettings({ skipDuplicates: false });

test('formatos: los videos se reconocen, y su salida candidata es .mp4 (con y sin choque de nombre)', () => {
  for (const f of ['a.mp4', 'a.MOV', 'a.mkv', 'a.avi', 'a.webm', 'a.m4v', 'a.wmv', 'a.mpeg', 'a.3gp']) {
    assert.equal(isSupportedMedia(f), true, f);
    assert.equal(mediaKind(f), 'video', f);
  }
  assert.equal(mediaKind('foto.JPG'), 'image');
  assert.equal(mediaKind('doc.pdf'), null);
  assert.equal(isSupportedMedia('._clip.mp4'), false, 'la basura de macOS con extension de video no cuenta');
  const names = candidateOutputFileNames('/x/Viaje.MOV');
  assert.ok(names.includes('viaje.mp4') && names.includes('viaje_mov.mp4') && names.includes('viaje.mov'));
  assert.ok(!names.includes('viaje.webp'), 'un video nunca se convierte a webp');
});

test('la cola procesa videos y fotos mezclados; los videos de uno en uno y con avance real', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-vq-'));
  const inDir = path.join(dir, 'in');
  const outDir = path.join(dir, 'out');
  await fs.mkdir(inDir, { recursive: true });
  const pairs = [];
  for (let i = 0; i < 2; i += 1) {
    const v = path.join(inDir, `video${i}.mp4`);
    makeVideo(v, { seconds: 6, size: '640x360' }); // lo bastante largo para ver el porcentaje avanzar
    pairs.push({ inputPath: v, outputPath: path.join(outDir, `video${i}.mp4`) });
  }
  for (let i = 0; i < 4; i += 1) {
    const p = path.join(inDir, `foto${i}.jpg`);
    await makePhoto(p);
    pairs.push({ inputPath: p, outputPath: path.join(outDir, `foto${i}.jpg`) });
  }

  const qm = new QueueManager();
  let maxVideosAtOnce = 0;
  const progressSeen = new Set();
  qm.on('queue-updated', () => {
    const processingVideos = qm.jobs.filter((j) => j.kind === 'video' && j.status === 'processing');
    maxVideosAtOnce = Math.max(maxVideosAtOnce, processingVideos.length);
    for (const j of processingVideos) if (j.progress != null) progressSeen.add(j.progress);
  });

  const finished = waitFor(qm, 'batch-finished');
  qm.addJobs(pairs);
  const summary = await finished;

  assert.equal(summary.errors, 0);
  assert.equal(summary.done, 6);
  assert.equal(maxVideosAtOnce, 1, 'nunca dos videos codificandose a la vez');
  assert.ok(progressSeen.size > 1, 'el porcentaje avanza de verdad');
  assert.ok(qm.jobs.every((j) => j.status === 'done' && j.progress === null), 'todo terminado y sin porcentaje residual');
  assert.equal(qm.jobs.filter((j) => j.kind === 'video').length, 2, 'cada trabajo sabe de que tipo es');
  for (const { outputPath } of pairs) await fs.access(outputPath);
  const snap = qm.getSnapshot();
  assert.ok(snap.jobs.every((j) => 'kind' in j && 'progress' in j), 'la ventana recibe tipo y avance');
  await fs.rm(dir, { recursive: true, force: true });
});

test('un video corrupto en la cola marca error y NO detiene al resto', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-vq-bad-'));
  const bad = path.join(dir, 'roto.mp4');
  await fs.writeFile(bad, 'no soy un video');
  const good = path.join(dir, 'foto.jpg');
  await makePhoto(good);

  const qm = new QueueManager();
  const finished = waitFor(qm, 'batch-finished');
  qm.addJobs([
    { inputPath: bad, outputPath: path.join(dir, 'out', 'roto.mp4') },
    { inputPath: good, outputPath: path.join(dir, 'out', 'foto.jpg') }
  ]);
  const summary = await finished;

  assert.equal(summary.errors, 1);
  assert.equal(summary.done, 1);
  assert.match(qm.jobs.find((j) => j.kind === 'video').error, /no es un v[ií]deo v[aá]lido/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('Detener no deja un video "a medias" colgado: lo en proceso termina y lo demas queda pendiente', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-vq-pause-'));
  const pairs = [];
  for (let i = 0; i < 3; i += 1) {
    const v = path.join(dir, `v${i}.mp4`);
    makeVideo(v, { seconds: 2 });
    pairs.push({ inputPath: v, outputPath: path.join(dir, 'out', `v${i}.mp4`) });
  }
  const qm = new QueueManager();
  qm.addJobs(pairs);
  qm.pause();
  await new Promise((resolve) => qm.once('queue-idle', resolve));
  assert.equal(qm.jobs.filter((j) => j.status === 'processing').length, 0, 'nada se queda en processing');
  assert.ok(qm.jobs.filter((j) => j.status === 'pending').length >= 2, 'el resto sigue en espera');
  const finished = waitFor(qm, 'batch-finished');
  qm.resume();
  const summary = await finished;
  assert.equal(summary.done, 3);
  await fs.rm(dir, { recursive: true, force: true });
});

test('importar: un video suelto, una carpeta con videos y un ZIP con un video entran en la cola', async () => {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-vq-imp-'));
  makeVideo(path.join(src, 'suelto.mp4'), { seconds: 1 });
  await fs.mkdir(path.join(src, 'Carpeta'));
  makeVideo(path.join(src, 'Carpeta', 'uno.mov'), { seconds: 1 });
  const clip = path.join(src, 'dentro.mp4');
  makeVideo(clip, { seconds: 1 });
  await fs.writeFile(path.join(src, 'Pack.zip'), makeZip([{ name: 'z/clip.mp4', data: await fs.readFile(clip) }, { name: 'z/nota.txt', data: 'x' }]));

  const result = await importPaths([path.join(src, 'suelto.mp4'), path.join(src, 'Carpeta'), path.join(src, 'Pack.zip')]);

  assert.equal(result.importedFiles.length, 3);
  assert.equal(result.skippedCount, 1, 'solo nota.txt se informa como no compatible');
  assert.ok(result.importedFiles.every((f) => mediaKind(f) === 'video'));
  await fs.rm(src, { recursive: true, force: true });
});
