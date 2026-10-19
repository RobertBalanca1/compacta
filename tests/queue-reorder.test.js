'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { QueueManager } = require('../src/main/queue-manager');

function queueOf(...specs) {
  const qm = new QueueManager();
  qm.paused = true; // sin procesar: solo se prueba el orden
  qm.jobs = specs.map(([id, status, kind]) => ({ id, name: id, kind: kind || 'image', status, progress: null, inputPath: `/x/${id}.jpg` }));
  return qm;
}
const ids = (qm) => qm.jobs.map((j) => j.id).join(',');
const claimOrder = (qm, kind = 'image') => {
  const order = [];
  for (let j = qm._claimNextPending(kind); j; j = qm._claimNextPending(kind)) order.push(j.id);
  return order.join(',');
};

test('mover antes de otro: a b c d -> d antes de b', () => {
  const qm = queueOf(['a', 'pending'], ['b', 'pending'], ['c', 'pending'], ['d', 'pending']);
  assert.equal(qm.moveJob('d', 'b'), true);
  assert.equal(ids(qm), 'a,d,b,c');
});

test('mover despues de otro: a pasa detras de c', () => {
  const qm = queueOf(['a', 'pending'], ['b', 'pending'], ['c', 'pending'], ['d', 'pending']);
  assert.equal(qm.moveJob('a', 'c', true), true);
  assert.equal(ids(qm), 'b,c,a,d');
});

test('el orden nuevo es el que de verdad se procesa (los cursores se reinician)', () => {
  const qm = queueOf(['a', 'pending'], ['b', 'pending'], ['c', 'pending'], ['d', 'pending']);
  // Se reclaman a y b: los cursores ya pasaron de ellos.
  qm._claimNextPending().status = 'done';
  qm._claimNextPending().status = 'done';
  assert.equal(qm.moveJob('d', 'c'), true); // d antes de c: ambos aun pendientes, DETRAS de los cursores
  assert.equal(claimOrder(qm), 'd,c');

  const second = queueOf(['a', 'pending'], ['b', 'pending'], ['c', 'pending']);
  assert.equal(second._claimNextPending().id, 'a'); // a queda "en proceso"
  second.jobs[0].status = 'processing';
  assert.equal(second.moveJob('c', 'b'), true);
  assert.equal(claimOrder(second), 'c,b', 'un pendiente que pasa DELANTE del cursor no se pierde');
});

test('solo se mueven pendientes: lo que ya se procesa, termino o fallo no se toca', () => {
  const qm = queueOf(['hecho', 'done'], ['en-curso', 'processing'], ['err', 'error'], ['p1', 'pending'], ['p2', 'pending']);
  const before = ids(qm);
  assert.equal(qm.moveJob('hecho', 'p1'), false);
  assert.equal(qm.moveJob('en-curso', 'p1'), false);
  assert.equal(qm.moveJob('p1', 'hecho'), false, 'ni se puede mover un pendiente DETRAS de uno ya terminado');
  assert.equal(qm.moveJob('p1', 'en-curso'), false);
  assert.equal(ids(qm), before);
  assert.equal(qm._orderVersion, 0, 'y no cuenta como reordenado');
});

test('ids desconocidos, el mismo id, y mover a donde ya esta: sin efecto', () => {
  const qm = queueOf(['a', 'pending'], ['b', 'pending']);
  assert.equal(qm.moveJob('nope', 'a'), false);
  assert.equal(qm.moveJob('a', 'nope'), false);
  assert.equal(qm.moveJob('a', 'a'), false);
  assert.equal(ids(qm), 'a,b');
});

test('cada reordenacion sube la version del orden, que viaja en el snapshot (la pantalla recoloca las filas)', () => {
  const qm = queueOf(['a', 'pending'], ['b', 'pending'], ['c', 'pending']);
  assert.equal(qm.getSnapshot().orderVersion, 0);
  qm.moveJob('c', 'a');
  assert.equal(qm.getSnapshot().orderVersion, 1);
  qm.moveJob('b', 'c', true);
  assert.equal(qm.getSnapshot().orderVersion, 2);
  // a,b,c -> (c antes de a) c,a,b -> (b despues de c) c,b,a
  assert.deepEqual(qm.getSnapshot().jobs.map((j) => j.id), ['c', 'b', 'a'], 'el snapshot trae el orden nuevo');
});

test('avisa a la pantalla (queue-updated) al reordenar', () => {
  const qm = queueOf(['a', 'pending'], ['b', 'pending']);
  let events = 0;
  qm.on('queue-updated', () => { events += 1; });
  qm.moveJob('b', 'a');
  assert.equal(events, 1);
});

test('fotos y videos: cada carril respeta el orden nuevo dentro de si mismo', () => {
  const qm = queueOf(['i1', 'pending'], ['v1', 'pending', 'video'], ['i2', 'pending'], ['v2', 'pending', 'video']);
  qm.moveJob('v2', 'v1');
  qm.moveJob('i2', 'i1');
  assert.equal(claimOrder(qm, 'video'), 'v2,v1');
  qm._cursors = { image: 0, video: 0 };
  assert.equal(claimOrder(qm, 'image'), 'i2,i1');
});

test('con 20.000 pendientes, mover es instantaneo y el reclamo sigue siendo lineal', () => {
  const specs = Array.from({ length: 20000 }, (_, i) => [`j${i}`, 'pending']);
  const qm = queueOf(...specs);
  const start = process.hrtime.bigint();
  for (let i = 0; i < 50; i += 1) qm.moveJob(`j${19999 - i}`, 'j0');
  let claimed = 0;
  while (qm._claimNextPending()) claimed += 1;
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(claimed, 20000);
  assert.ok(ms < 800, `tardo ${ms.toFixed(0)} ms`);
});
