'use strict';

// La cola debe seguir siendo rapida con lotes grandes: reclamar el siguiente
// pendiente es O(1) amortizado y avisar de un cambio no copia la lista.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { QueueManager } = require('../src/main/queue-manager');

function fakeJobs(n) {
  return Array.from({ length: n }, (_, i) => ({ id: String(i), name: `${i}.jpg`, inputPath: `/x/${i}.jpg`, status: 'pending', report: null, error: null }));
}

test('reclamar los trabajos sale en orden y cada uno exactamente una vez', () => {
  const qm = new QueueManager();
  qm.jobs = fakeJobs(1000);
  const seen = [];
  for (let job = qm._claimNextPending(); job; job = qm._claimNextPending()) seen.push(job.id);
  assert.equal(seen.length, 1000);
  assert.deepEqual(seen, qm.jobs.map((j) => j.id));
  assert.equal(qm._claimNextPending(), null);
});

test('con 50.000 trabajos, reclamarlos todos es casi instantaneo (no cuadratico)', () => {
  const qm = new QueueManager();
  qm.jobs = fakeJobs(50000);
  const start = process.hrtime.bigint();
  let count = 0;
  while (qm._claimNextPending()) count += 1;
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(count, 50000);
  assert.ok(ms < 500, `tardo ${ms.toFixed(0)} ms; el algoritmo antiguo (find por trabajo) tardaba segundos`);
});

test('avisar de cambios NO construye la lista completa (solo getSnapshot la construye)', () => {
  const qm = new QueueManager();
  qm.jobs = fakeJobs(20000);
  let calls = 0;
  const original = qm.getSnapshot.bind(qm);
  qm.getSnapshot = () => { calls += 1; return original(); };
  let events = 0;
  qm.on('queue-updated', () => { events += 1; });
  for (let i = 0; i < 5000; i += 1) qm._emitUpdate();
  assert.equal(events, 5000);
  assert.equal(calls, 0, 'ningun aviso debe copiar los 20.000 trabajos');
});

test('tras limpiar completados el cursor se reinicia y no se pierden pendientes', () => {
  const qm = new QueueManager();
  qm.jobs = fakeJobs(10);
  for (let i = 0; i < 4; i += 1) qm._claimNextPending().status = 'done';
  qm.clearFinished();
  assert.equal(qm.jobs.length, 6);
  assert.equal(qm._claimNextPending().id, '4');
});

test('agregar trabajos despues de vaciar la cola vuelve a encontrarlos', () => {
  const qm = new QueueManager();
  qm.paused = true; // sin workers: solo se prueba la contabilidad
  qm.addJobs([{ inputPath: '/a/1.jpg', outputPath: '/o/1.jpg' }]);
  const first = qm._claimNextPending();
  first.status = 'done';
  assert.equal(qm._hasPending(), false);
  qm.addJobs([{ inputPath: '/a/2.jpg', outputPath: '/o/2.jpg' }]);
  assert.equal(qm._hasPending(), true);
  assert.equal(qm._claimNextPending().name, '2.jpg');
});

test('addJobs acepta listas enormes (sin push(...lista))', () => {
  const qm = new QueueManager();
  qm.paused = true;
  const pairs = Array.from({ length: 200000 }, (_, i) => ({ inputPath: `/a/${i}.jpg`, outputPath: `/o/${i}.jpg` }));
  assert.doesNotThrow(() => qm.addJobs(pairs));
  assert.equal(qm.jobs.length, 200000);
});

test('REGRESION: la regla .hidden gana siempre (el aviso de OneDrive no se podia cerrar)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'css', 'styles.css'), 'utf-8');
  assert.match(css, /\.hidden:not\(\.toast\)\s*\{\s*display:\s*none\s*!important/, '.hidden debe llevar !important');
  // Y no puede quedar ningun `.hidden { display: none }` simple: era la regla perdedora.
  assert.doesNotMatch(css, /^\.hidden\s*\{\s*display:\s*none;\s*\}/m);
});
