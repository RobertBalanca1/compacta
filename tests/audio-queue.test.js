'use strict';

// Los audios dentro de TODO el flujo real: importar (suelto, carpeta, ZIP), cola con su
// propio carril, "ya procesado" al reabrir, y omitir duplicados.

const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.COMPACTA_TEST_BASE_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'compacta-aq-base-'));

const sharp = require('sharp');
const { QueueManager } = require('../src/main/queue-manager');
const { importPaths } = require('../src/main/importer');
const { saveSettings } = require('../src/main/settings-store');
const { findUnprocessedFiles, listBatches, getOutputPathFor, hasOutputFor } = require('../src/main/file-manager');
const { createDuplicateDetector } = require('../src/main/duplicates');
const { makeAudio } = require('./helpers/make-audio');
const { makeVideo } = require('./helpers/make-video');
const { makeZip } = require('./helpers/make-zip');

const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), `compacta-aq-${p}-`));
const WAV = ['-c:a', 'pcm_s16le'];

async function runQueue(files) {
  const qm = new QueueManager();
  const done = new Promise((resolve) => qm.once('batch-finished', resolve));
  qm.addJobs(files.map((inputPath) => ({ inputPath, outputPath: getOutputPathFor(inputPath) })));
  await done;
  return qm;
}

test.beforeEach(() => saveSettings({ skipDuplicates: true, quality: 90, aggressive: false, convertToWebp: false, maxCompression: false }));

test('soltar audios sueltos de varios formatos: se importan, se comprimen y salen en output/', async () => {
  const src = await tmp('loose');
  makeAudio(path.join(src, 'sermon.wav'), { codecArgs: WAV, seconds: 3 });
  makeAudio(path.join(src, 'musica.flac'), { codecArgs: ['-c:a', 'flac'], seconds: 3, rate: 48000 });
  makeAudio(path.join(src, 'nota.caf'), { codecArgs: ['-c:a', 'pcm_s16le'], seconds: 3 });
  makeAudio(path.join(src, 'pista.aiff'), { codecArgs: ['-c:a', 'pcm_s16be'], seconds: 3 });
  const result = await importPaths(['sermon.wav', 'musica.flac', 'nota.caf', 'pista.aiff'].map((n) => path.join(src, n)));
  assert.equal(result.importedFiles.length, 4);
  assert.equal(result.skippedCount, 0, 'ningun audio se descarta como "formato no compatible"');

  const qm = await runQueue(result.importedFiles);
  assert.ok(qm.jobs.every((j) => j.kind === 'audio'), 'todos van por el carril de audio');
  assert.deepEqual(qm.jobs.map((j) => j.status), ['done', 'done', 'done', 'done'], JSON.stringify(qm.jobs.map((j) => j.error)));
  for (const job of qm.jobs) {
    assert.equal(path.extname(job.report.output), '.mp3');
    assert.ok(job.report.newBytes < job.report.originalBytes);
    assert.ok(fsSync.existsSync(job.report.output));
  }
  assert.ok(qm.getSnapshot().totalSavedBytes > 0);
  await fs.rm(src, { recursive: true, force: true });
});

test('una carpeta con fotos, videos y audios mezclados: cada uno por su carril y todo termina', async () => {
  const src = await tmp('mixed');
  await fs.mkdir(path.join(src, 'Culto'));
  await sharp({ create: { width: 500, height: 400, channels: 3, noise: { type: 'gaussian', mean: 110, sigma: 50 } } }).jpeg({ quality: 97 }).toFile(path.join(src, 'Culto', 'foto.jpg'));
  makeVideo(path.join(src, 'Culto', 'clip.mp4'), { seconds: 2 });
  for (let i = 0; i < 6; i += 1) makeAudio(path.join(src, 'Culto', `pista${i}.wav`), { codecArgs: WAV, seconds: 5 + i * 0.2 });
  const result = await importPaths([src]);
  assert.equal(result.importedFiles.length, 8);

  const qm = new QueueManager();
  let maxAudioAtOnce = 0;
  qm.on('queue-updated', () => { maxAudioAtOnce = Math.max(maxAudioAtOnce, qm.jobs.filter((j) => j.kind === 'audio' && j.status === 'processing').length); });
  const finished = new Promise((resolve) => qm.once('batch-finished', resolve));
  qm.addJobs(result.importedFiles.map((inputPath) => ({ inputPath, outputPath: getOutputPathFor(inputPath) })));
  const summary = await finished;
  assert.equal(summary.errors, 0, JSON.stringify(qm.jobs.filter((j) => j.error).map((j) => j.error)));
  assert.equal(summary.done, 8);
  assert.deepEqual([...new Set(qm.jobs.map((j) => j.kind))].sort(), ['audio', 'image', 'video']);
  assert.ok(maxAudioAtOnce >= 1 && maxAudioAtOnce <= 4, `audios a la vez: ${maxAudioAtOnce}`);
  const snapshot = qm.getSnapshot();
  assert.equal(snapshot.progress.finished, true);
  assert.equal(snapshot.progress.fraction, 1);
  await fs.rm(src, { recursive: true, force: true });
});

test('audios dentro de un ZIP y de una carpeta con subcarpetas', async () => {
  const src = await tmp('zip');
  const wav = path.join(src, 'x.wav');
  makeAudio(wav, { codecArgs: WAV, seconds: 4.4 });
  const bytes = await fs.readFile(wav);
  const m4a = path.join(src, 'y.m4a');
  makeAudio(m4a, { codecArgs: ['-c:a', 'aac', '-b:a', '320k'], seconds: 2 });
  const zipPath = path.join(src, 'audios.zip');
  await fs.writeFile(zipPath, makeZip([{ name: 'Album/uno.wav', data: bytes }, { name: 'Album/Disco 2/dos.m4a', data: await fs.readFile(m4a) }, { name: 'Album/leeme.txt', data: 'hola' }]));
  const result = await importPaths([zipPath]);
  assert.equal(result.importedFiles.length, 2, 'los dos audios salen del ZIP');
  const qm = await runQueue(result.importedFiles);
  assert.deepEqual(qm.jobs.map((j) => j.status), ['done', 'done']);
  await fs.rm(src, { recursive: true, force: true });
});

test('"ya procesado" tambien vale para audios, aunque la extension de salida cambie (wav -> mp3)', async () => {
  const src = await tmp('resume');
  makeAudio(path.join(src, 'grabacion.wav'), { codecArgs: WAV, seconds: 2 });
  makeAudio(path.join(src, 'otra.flac'), { codecArgs: ['-c:a', 'flac'], seconds: 2 });
  const { importedFiles } = await importPaths([path.join(src, 'grabacion.wav'), path.join(src, 'otra.flac')]);
  const before = await findUnprocessedFiles(await listBatches());
  assert.ok(importedFiles.every((f) => before.includes(f)), 'antes de procesar, estan pendientes');
  await runQueue(importedFiles);
  // El registro interno se ignora a proposito: tiene que bastar con mirar output/.
  for (const file of importedFiles) assert.equal(await hasOutputFor(file), true, path.basename(file));
  assert.ok(fsSync.readdirSync(path.dirname(getOutputPathFor(importedFiles[0]))).some((n) => n.endsWith('.mp3')));
  await fs.rm(src, { recursive: true, force: true });
});

test('omitir duplicados tambien funciona con audios: copias iguales con otro nombre, y soltar lo ya comprimido', async () => {
  const src = await tmp('dups');
  makeAudio(path.join(src, 'original.wav'), { codecArgs: WAV, seconds: 2.5 });
  await fs.copyFile(path.join(src, 'original.wav'), path.join(src, 'copia de original.wav'));
  await fs.copyFile(path.join(src, 'original.wav'), path.join(src, 'otra copia.wav'));
  makeAudio(path.join(src, 'distinto.wav'), { codecArgs: WAV, seconds: 3.5 });

  const first = await importPaths([src]);
  assert.equal(first.importedFiles.length, 2, 'original + distinto');
  assert.equal(first.duplicateInDrop, 2);
  const qm = await runQueue(first.importedFiles);

  // Otra vez lo mismo: ya esta comprimido, se omite y se recuerda de donde venia (para "Procesar de todos modos").
  const isLive = async (p) => qm.jobs.some((j) => j.inputPath === p && j.status !== 'error') || hasOutputFor(p);
  const second = await importPaths([src], { isLive });
  assert.equal(second.importedFiles.length, 0);
  assert.equal(second.duplicateBefore, 4);
  assert.equal(second.duplicateSources.length, 4);
  assert.ok(second.duplicateSources.every((s) => s.startsWith(src)));

  // Y con "procesar de todos modos" entra, sin tocar el ajuste.
  const forced = await importPaths(second.duplicateSources, { isLive, allowDuplicates: true });
  assert.equal(forced.importedFiles.length, 4);
  assert.equal(forced.duplicateCount, 0);
  assert.equal(require('../src/main/settings-store').loadSettings().skipDuplicates, true, 'el ajuste sigue activado');
  await fs.rm(src, { recursive: true, force: true });
});

test('dos audios del mismo tamano pero distintos NO son duplicados', async () => {
  const src = await tmp('same-size');
  const a = Buffer.alloc(20000, 3);
  const b = Buffer.alloc(20000, 3);
  b[19999] = 9;
  await fs.writeFile(path.join(src, 'a.mp3'), a);
  await fs.writeFile(path.join(src, 'b.mp3'), b);
  const result = await importPaths([src]);
  assert.equal(result.importedFiles.length, 2);
  assert.equal(result.duplicateCount, 0);
  await fs.rm(src, { recursive: true, force: true });
});

// ---------------------------------------------------------------- duplicados: que un fallo no lo tumbe todo
test('si comparar un archivo falla (se borro, esta bloqueado...) ese archivo cuenta como UNICO y la importacion sigue', async () => {
  const dir = await tmp('fail-compare');
  const input = path.join(dir, 'input');
  await fs.mkdir(input);
  const known = path.join(input, 'conocido.jpg');
  await fs.writeFile(known, Buffer.alloc(4000, 7));
  const detector = await createDuplicateDetector(input, { isLive: async () => { throw new Error('el disco desaparecio'); } });
  const incoming = path.join(input, 'nuevo.jpg');
  await fs.writeFile(incoming, Buffer.alloc(4000, 7)); // identico: obliga a llamar a isLive, que falla
  const other = path.join(input, 'otro.jpg');
  await fs.writeFile(other, Buffer.alloc(3000, 1));
  const { unique, duplicates } = await detector.filter([incoming, other]);
  assert.deepEqual(unique, [incoming, other], 'nada se pierde: ante la duda, se procesa');
  assert.equal(duplicates.length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('con miles de archivos ya comprimidos, volver a soltarlos NO se cuelga (la comprobacion ya no es cuadratica)', async () => {
  const src = await tmp('many');
  const N = 1500;
  await fs.mkdir(path.join(src, 'Gran'));
  for (let i = 0; i < N; i += 1) {
    const b = Buffer.alloc(300 + (i % 7), i % 251);
    b.writeUInt32BE(i, 0);
    await fs.writeFile(path.join(src, 'Gran', `f${i}.mp3`), b);
  }
  const first = await importPaths([path.join(src, 'Gran')]);
  assert.equal(first.importedFiles.length, N);
  // Se simulan como "ya hechos": hay resultado en output/ para cada uno.
  for (const f of first.importedFiles) {
    const out = getOutputPathFor(f);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, 'x');
  }
  const outputListings = new Map();
  const isLive = async (p) => hasOutputFor(p, outputListings);
  const started = Date.now();
  const second = await importPaths([path.join(src, 'Gran')], { isLive });
  const took = Date.now() - started;
  assert.equal(second.duplicateBefore, N);
  assert.equal(second.importedFiles.length, 0);
  assert.ok(took < 20000, `tardo ${took} ms`);
  await fs.rm(src, { recursive: true, force: true });
});
