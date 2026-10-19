'use strict';

// Comportamiento del grupo de workers y del resumen de lote, con imagenes
// reales pequeñas (usa el compresor de verdad, sin simulacros).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { QueueManager } = require('../src/main/queue-manager');

async function makeJobs(count) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-qb-'));
  const outDir = path.join(dir, 'out');
  await fs.mkdir(outDir, { recursive: true });
  const pairs = [];
  for (let i = 0; i < count; i += 1) {
    const inputPath = path.join(dir, `f${i}.jpg`);
    await sharp({ create: { width: 900, height: 700, channels: 3, noise: { type: 'gaussian', mean: 100, sigma: 30 } } })
      .jpeg({ quality: 95 }).toFile(inputPath);
    pairs.push({ inputPath, outputPath: path.join(outDir, `f${i}.jpg`) });
  }
  return { dir, pairs };
}

function waitFor(emitter, event, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout esperando ${event}`)), timeoutMs);
    emitter.once(event, (payload) => { clearTimeout(t); resolve(payload); });
  });
}

test('batch-finished se emite UNA vez, al terminar de verdad, con el total del lote', async () => {
  const { dir, pairs } = await makeJobs(6);
  const qm = new QueueManager();
  qm.concurrency = 2;
  const summaries = [];
  qm.on('batch-finished', (s) => summaries.push(s));

  const finished = waitFor(qm, 'batch-finished');
  qm.addJobs(pairs);
  const summary = await finished;
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(summary.done, 6);
  assert.equal(summary.errors, 0);
  assert.equal(summaries.length, 1, 'no debe emitirse mas de una vez');
  await fs.rm(dir, { recursive: true, force: true });
});

test('Detener NO cuenta como terminado; el resumen llega al acabar tras Reanudar, con todo el lote', async () => {
  const { dir, pairs } = await makeJobs(6);
  const qm = new QueueManager();
  qm.concurrency = 1;
  const summaries = [];
  qm.on('batch-finished', (s) => summaries.push(s));

  qm.addJobs(pairs);
  qm.pause(); // el primero ya esta en curso; los demas quedan en espera
  await waitFor(qm, 'queue-idle');
  assert.equal(summaries.length, 0, 'detener no debe disparar el aviso de lote terminado');
  assert.ok(qm.jobs.some((j) => j.status === 'pending'), 'debian quedar fotos en espera');

  const finished = waitFor(qm, 'batch-finished');
  qm.resume();
  const summary = await finished;

  assert.equal(summary.done, 6, 'el conteo incluye lo hecho antes de detener');
  assert.equal(summaries.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('agregar fotos mientras se procesa recupera el paralelismo (antes seguia de una en una)', async () => {
  const { dir, pairs } = await makeJobs(8);
  const qm = new QueueManager();
  qm.concurrency = 3;

  qm.addJobs(pairs.slice(0, 1));
  assert.equal(qm.activeWorkers, 1, 'con una sola foto solo hace falta un worker');

  qm.addJobs(pairs.slice(1));
  assert.equal(qm.activeWorkers, 3, 'al llegar mas fotos se levantan los workers que faltaban');

  await waitFor(qm, 'batch-finished');
  assert.equal(qm.activeWorkers, 0);
  assert.equal(qm.isProcessing, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('Reanudar recupera todos los workers aunque uno siguiera terminando', async () => {
  const { dir, pairs } = await makeJobs(9);
  const qm = new QueueManager();
  qm.concurrency = 3;
  qm.addJobs(pairs);
  qm.pause();
  qm.resume();
  assert.equal(qm.activeWorkers, 3, 'tras detener y reanudar al instante debe volver a haber 3 workers');
  await waitFor(qm, 'batch-finished');
  await fs.rm(dir, { recursive: true, force: true });
});

test('una foto corrupta cuenta como error del lote y no detiene al resto', async () => {
  const { dir, pairs } = await makeJobs(3);
  await fs.writeFile(pairs[1].inputPath, 'esto no es una imagen');
  const qm = new QueueManager();
  qm.concurrency = 1;
  const finished = waitFor(qm, 'batch-finished');
  qm.addJobs(pairs);
  const summary = await finished;
  assert.equal(summary.done, 2);
  assert.equal(summary.errors, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('Eliminar pendientes con todo detenido reinicia el conteo sin avisar', async () => {
  const { dir, pairs } = await makeJobs(4);
  const qm = new QueueManager();
  qm.concurrency = 1;
  const summaries = [];
  qm.on('batch-finished', (s) => summaries.push(s));
  qm.addJobs(pairs);
  qm.pause();
  await waitFor(qm, 'queue-idle');
  await qm.cancelPending();
  assert.deepEqual(qm.batch, { done: 0, errors: 0, savedBytes: 0 });
  assert.equal(summaries.length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});
