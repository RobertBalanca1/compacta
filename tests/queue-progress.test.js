'use strict';

// Progreso global en la cola real: lote actual, tamanos leidos en segundo
// plano y tiempo activo (la pausa no cuenta).

const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.COMPACTA_TEST_BASE_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'compacta-qp-base-'));

const sharp = require('sharp');
const { QueueManager } = require('../src/main/queue-manager');

async function photos(dir, n) {
  await fs.mkdir(dir, { recursive: true });
  const pairs = [];
  for (let i = 0; i < n; i += 1) {
    const inputPath = path.join(dir, `f${i}.jpg`);
    await sharp({ create: { width: 300, height: 200, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 40 } } }).jpeg({ quality: 97 }).toFile(inputPath);
    pairs.push({ inputPath, outputPath: path.join(dir, 'out', `f${i}.jpg`) });
  }
  return pairs;
}
const finished = (qm) => new Promise((resolve) => qm.once('batch-finished', resolve));

test('el snapshot trae el progreso del lote y, al terminar, 100 % con ETA 0', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-qp-'));
  const qm = new QueueManager();
  const done = finished(qm);
  qm.addJobs(await photos(dir, 4));
  await done;
  const { progress } = qm.getSnapshot();
  assert.equal(progress.total, 4);
  assert.equal(progress.done, 4);
  assert.equal(progress.fraction, 1);
  assert.equal(progress.etaMs, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('los tamanos se leen en segundo plano y coinciden con los archivos', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-qp-size-'));
  const pairs = await photos(dir, 3);
  const qm = new QueueManager();
  qm.paused = true; // sin procesar: solo se mira la lectura de tamanos
  qm.addJobs(pairs);
  // Se ESPERA a que la lectura termine (en una maquina lenta o con la CPU repartida, un tiempo fijo de 200 ms a veces no bastaba).
  const deadline = Date.now() + 10000;
  while (qm.jobs.some((job) => job.size === null) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  for (const job of qm.jobs) assert.equal(job.size, (await fs.stat(job.inputPath)).size);
  await fs.rm(dir, { recursive: true, force: true });
});

test('un lote nuevo empieza de cero aunque queden trabajos terminados del anterior en la lista', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-qp-batch-'));
  const qm = new QueueManager();
  let done = finished(qm);
  qm.addJobs(await photos(path.join(dir, 'a'), 2));
  await done;
  done = finished(qm);
  qm.addJobs(await photos(path.join(dir, 'b'), 3));
  await done;
  assert.equal(qm.jobs.length, 5, 'los 5 siguen en la cola');
  const { progress } = qm.getSnapshot();
  assert.equal(progress.total, 3, 'el progreso global es solo el del lote actual');
  assert.equal(progress.done, 3);
  await fs.rm(dir, { recursive: true, force: true });
});

test('trabajo anadido a mitad de un lote se suma a ESE lote', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-qp-mid-'));
  const qm = new QueueManager();
  qm.paused = true;
  qm.addJobs(await photos(path.join(dir, 'a'), 2));
  qm.addJobs(await photos(path.join(dir, 'b'), 2));
  assert.equal(qm.getSnapshot().progress.total, 4, 'misma tanda mientras no haya terminado');
  await fs.rm(dir, { recursive: true, force: true });
});

test('en pausa y sin nada en marcha no corre el reloj: sin estimacion y sin tiempo acumulado', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-qp-pause-'));
  const qm = new QueueManager();
  qm.paused = true;
  qm.addJobs(await photos(dir, 2));
  await new Promise((r) => setTimeout(r, 1800)); // mas que el minimo de 1,5 s
  const { progress } = qm.getSnapshot();
  assert.equal(progress.etaMs, null);
  assert.equal(qm._activeMs, 0);
  assert.equal(qm._activeSince, null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('importando carpeta a carpeta: aunque la cola se vacie entre una y otra, el lote es UNO (la barra no vuelve a 0)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-qp-import-'));
  const qm = new QueueManager();
  let finishedEvents = 0;
  qm.on('batch-finished', () => { finishedEvents += 1; });
  const idle = () => new Promise((resolve) => qm.once('queue-idle', resolve));

  qm.beginImport();
  let waiting = idle();
  qm.addJobs(await photos(path.join(dir, 'a'), 3)); // primera carpeta
  await waiting;
  const mid = qm.getSnapshot().progress;
  assert.equal(mid.done, 3);
  assert.equal(mid.finished, false, 'sigue importando: no esta terminado');
  assert.ok(mid.fraction < 1, 'no llega al 100 % con la importacion abierta');
  assert.equal(finishedEvents, 0, 'tampoco se avisa de "terminado" todavia');

  waiting = idle();
  qm.addJobs(await photos(path.join(dir, 'b'), 3)); // segunda carpeta, con la cola ya vacia
  await waiting;
  const second = qm.getSnapshot().progress;
  assert.equal(second.total, 6, 'mismo lote: 6 en total, no 3 de un lote nuevo');
  assert.ok(second.fraction >= mid.fraction, 'la barra no retrocede');
  assert.equal(finishedEvents, 0);

  qm.endImport();
  const last = qm.getSnapshot().progress;
  assert.equal(last.finished, true);
  assert.equal(last.fraction, 1);
  assert.equal(finishedEvents, 1, 'se avisa UNA sola vez, al terminar de verdad');
  await fs.rm(dir, { recursive: true, force: true });
});

test('"Limpiar completados" en mitad del lote: el total y lo hecho se conservan', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-qp-clear-'));
  const qm = new QueueManager();
  const done = finished(qm);
  qm.addJobs(await photos(dir, 4));
  await done;
  qm.clearFinished();
  assert.equal(qm.jobs.length, 0);
  const { progress } = qm.getSnapshot();
  assert.equal(progress.total, 4);
  assert.equal(progress.done, 4);
  assert.equal(progress.fraction, 1);
  await fs.rm(dir, { recursive: true, force: true });
});
