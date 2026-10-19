'use strict';

// Pruebas de la logica de estados de la cola. Para la maquina de estados
// (que se elimina y que no) se manipula el array `jobs` directamente, sin
// pasar por addJobs/optimizeImage, para no depender de sharp. Para la
// eliminacion del archivo fisico en input/ (la parte que evita que
// "Eliminar" reaparezca solo al reiniciar la app) se usan archivos
// temporales reales.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { QueueManager } = require('../src/main/queue-manager');

test('cancelPending elimina solo los pendientes; processing/done/error quedan intactos', async () => {
  const qm = new QueueManager();
  qm.jobs = [
    { id: '1', status: 'pending', inputPath: '/no-existe/1.jpg' },
    { id: '2', status: 'processing', inputPath: '/no-existe/2.jpg' },
    { id: '3', status: 'done', inputPath: '/no-existe/3.jpg' },
    { id: '4', status: 'error', inputPath: '/no-existe/4.jpg' },
    { id: '5', status: 'pending', inputPath: '/no-existe/5.jpg' }
  ];
  qm.paused = true;

  await qm.cancelPending();

  const remainingIds = qm.jobs.map((j) => j.id).sort();
  assert.deepEqual(remainingIds, ['2', '3', '4'], 'debe quedar solo lo que no estaba pendiente');
  assert.equal(qm.paused, false, 'sin nada pendiente que reanudar, se limpia el estado de pausa');
});

test('cancelPending no hace nada si no hay pendientes (no pisa el estado de pausa)', async () => {
  const qm = new QueueManager();
  qm.jobs = [{ id: '1', status: 'processing', inputPath: '/no-existe/1.jpg' }];
  qm.paused = true;

  await qm.cancelPending();

  assert.equal(qm.jobs.length, 1, 'no debe tocar trabajos que no estan pendientes');
  assert.equal(qm.paused, true, 'si no habia nada que eliminar, el estado de pausa no cambia');
});

test('getSnapshot refleja el estado tras cancelPending', async () => {
  const qm = new QueueManager();
  qm.jobs = [
    { id: '1', status: 'pending', report: null, inputPath: '/no-existe/1.jpg' },
    { id: '2', status: 'done', report: { savedBytes: 1000 }, inputPath: '/no-existe/2.jpg' }
  ];
  qm.paused = true;

  await qm.cancelPending();
  const snapshot = qm.getSnapshot();

  assert.equal(snapshot.jobs.length, 1);
  assert.equal(snapshot.jobs[0].id, '2');
  assert.equal(snapshot.paused, false);
  assert.equal(snapshot.totalSavedBytes, 1000, 'el ahorro acumulado de lo ya terminado no se pierde');
});

test('cancelPending borra el archivo en input/ de lo pendiente, para que no reaparezca al reiniciar', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-cancel-'));
  const pendingPath = path.join(dir, 'pendiente.jpg');
  const processingPath = path.join(dir, 'procesando.jpg');
  await fs.writeFile(pendingPath, 'contenido-pendiente');
  await fs.writeFile(processingPath, 'contenido-procesando');

  const qm = new QueueManager();
  qm.jobs = [
    { id: '1', status: 'pending', inputPath: pendingPath },
    { id: '2', status: 'processing', inputPath: processingPath }
  ];
  qm.paused = true;

  await qm.cancelPending();

  await assert.rejects(fs.access(pendingPath), 'el archivo pendiente eliminado no debe seguir en input/');
  await assert.doesNotReject(fs.access(processingPath), 'el archivo que seguia procesandose no debe tocarse');

  await fs.rm(dir, { recursive: true, force: true });
});
