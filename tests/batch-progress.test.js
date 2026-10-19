'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeBatch, BatchTracker } = require('../src/main/batch-progress');

const job = (kind, status, size, progress) => ({ kind, status, size, progress });

test('lote vacio y lote sin empezar: 0 %, sin estimacion', () => {
  const { lanes, ...empty } = summarizeBatch([], 5000);
  assert.deepEqual(empty, { total: 0, done: 0, errors: 0, processing: 0, fraction: 0, etaMs: 0 });
  assert.ok(lanes.image && lanes.video);
  const r = summarizeBatch([job('image', 'pending', 100), job('image', 'pending', 100)], 5000);
  assert.equal(r.fraction, 0);
  assert.equal(r.etaMs, null, 'sin nada hecho no se inventa un tiempo');
});

test('lote terminado: 100 % y ETA 0 (cuentan hechos y con error)', () => {
  const r = summarizeBatch([job('image', 'done', 10), job('image', 'error', 10), job('video', 'done', 1000)], 60000);
  assert.equal(r.fraction, 1);
  assert.equal(r.etaMs, 0);
  assert.equal(r.done, 2);
  assert.equal(r.errors, 1);
});

test('el peso es el tamano: un video enorme pesa mucho mas que mil fotos pequenas', () => {
  const jobs = [job('video', 'done', 1000)];
  for (let i = 0; i < 9; i += 1) jobs.push(job('image', 'pending', 1));
  const r = summarizeBatch(jobs, 10000);
  assert.ok(r.fraction > 0.98, `casi todo el trabajo (los bytes) ya esta hecho: ${r.fraction}`);
});

test('ETA de un solo carril: ritmo = hecho/tiempo; falta lo mismo que ya se hizo -> tarda lo mismo', () => {
  // 5 de 10 fotos iguales hechas en 10 s -> faltan 10 s
  const jobs = [];
  for (let i = 0; i < 5; i += 1) jobs.push(job('image', 'done', 100));
  for (let i = 0; i < 5; i += 1) jobs.push(job('image', 'pending', 100));
  assert.equal(summarizeBatch(jobs, 10000).etaMs, 10000);
});

test('NO se estima con muy poco tiempo medido (antes de 1,5 s todo ritmo es ruido)', () => {
  const r = summarizeBatch([job('image', 'done', 100), job('image', 'pending', 100)], 400);
  assert.equal(r.etaMs, null);
});

test('fotos y videos van por carriles: gana el mas lento, y no se miente al principio', () => {
  // Fotos casi acabadas (rapidas) pero un video largo aun sin empezar:
  const jobs = [job('image', 'done', 100), job('image', 'done', 100), job('image', 'pending', 100), job('video', 'pending', 5000)];
  assert.equal(summarizeBatch(jobs, 20000).etaMs, null, 'el video no tiene ritmo medido todavia: "calculando"');

  // Con el video al 25 % tras 20 s: le faltan 3x lo ya hecho = 60 s, mas que lo que falta de fotos (10 s).
  const running = [job('image', 'done', 100), job('image', 'done', 100), job('image', 'pending', 100), job('video', 'processing', 5000, 0.25)];
  const r = summarizeBatch(running, 20000);
  assert.ok(r.etaMs >= 59000 && r.etaMs <= 61000, `la estimacion la marca el video: ${r.etaMs}`);
});

test('un carril terminado no frena la estimacion del otro', () => {
  const jobs = [job('image', 'done', 100), job('video', 'processing', 1000, 0.5)];
  assert.equal(summarizeBatch(jobs, 10000).etaMs, 10000);
});

test('tamano desconocido: se usa el medio de los conocidos (y 1 si no hay ninguno)', () => {
  const r = summarizeBatch([job('image', 'done', 100), job('image', 'pending', undefined)], 10000);
  assert.equal(r.fraction, 0.5);
  assert.equal(r.etaMs, 10000);
  assert.equal(summarizeBatch([job('image', 'pending', undefined)], 5000).fraction, 0, 'no divide por cero');
});

test('una foto "en proceso" cuenta como medio hecha; un video, por su porcentaje real', () => {
  assert.equal(summarizeBatch([job('image', 'processing', 100)], 0).fraction, 0.5);
  assert.equal(summarizeBatch([job('video', 'processing', 100, 0.2)], 0).fraction, 0.2);
});


// ---------------------------------------------------------------------------
// BatchTracker: la barra no retrocede y el tiempo estimado es fiable
// ---------------------------------------------------------------------------

/**
 * Simula un lote: `n` fotos, `workers` en paralelo, cada una tarda `jobMs` +/- 30 %
 * (generador determinista). Llama a `onTick(jobs, ms)` cada `stepMs` y devuelve el
 * tiempo total real. `addAt` permite anadir trabajo a mitad (importacion por carpetas).
 */
function simulate({ n, workers = 4, jobMs = 1000, sizeOf = () => 3_000_000, stepMs = 120, onTick, addAt = {} }) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const jobs = [];
  const add = (count) => { for (let i = 0; i < count; i += 1) jobs.push({ kind: 'image', status: 'pending', size: sizeOf(jobs.length), progress: null, _left: 0 }); };
  add(n);
  const running = [];
  let t = 0;
  for (;;) {
    if (addAt[t]) add(addAt[t]);
    while (running.length < workers) {
      const next = jobs.find((j) => j.status === 'pending');
      if (!next) break;
      next.status = 'processing';
      next._left = jobMs * (0.7 + rnd() * 0.6);
      running.push(next);
    }
    for (const j of [...running]) {
      j._left -= stepMs;
      if (j._left <= 0) { j.status = 'done'; running.splice(running.indexOf(j), 1); }
    }
    t += stepMs;
    if (onTick) onTick(jobs, t);
    const pendingAhead = Object.keys(addAt).some((k) => Number(k) >= t);
    if (!pendingAhead && jobs.every((j) => j.status === 'done')) return t;
  }
}

test('la barra NUNCA retrocede aunque el lote crezca a mitad (importacion carpeta a carpeta)', () => {
  const tracker = new BatchTracker();
  let last = 0;
  let worst = 0;
  simulate({
    n: 20,
    addAt: { 6000: 30, 14000: 40 },
    onTick: (jobs, t) => {
      const r = tracker.update(jobs, t, { importing: t < 15000 });
      worst = Math.min(worst, r.fraction - last);
      last = r.fraction;
    }
  });
  assert.ok(worst >= 0, `la barra bajo ${worst}`);
});

test('con la importacion abierta el lote no se da por terminado ni llega al 100 % entre carpetas', () => {
  const tracker = new BatchTracker();
  const done = [job('image', 'done', 100), job('image', 'done', 100)];
  const r = tracker.update(done, 5000, { importing: true });
  assert.equal(r.finished, false);
  assert.ok(r.fraction < 1);
  assert.equal(r.importing, true);
  assert.equal(tracker.update(done, 5100, { importing: false }).finished, true);
});

test('"Limpiar completados" a mitad del lote no hace retroceder la barra ni el conteo', () => {
  const tracker = new BatchTracker();
  const jobs = [];
  for (let i = 0; i < 5; i += 1) jobs.push(job('image', 'done', 100));
  for (let i = 0; i < 5; i += 1) jobs.push(job('image', 'pending', 100));
  const before = tracker.update(jobs, 4000);
  const finishedJobs = jobs.filter((j) => j.status === 'done');
  tracker.retire(finishedJobs, jobs);
  const after = tracker.update(jobs.filter((j) => j.status !== 'done'), 4100);
  assert.equal(after.total, 10);
  assert.equal(after.done, 5);
  assert.ok(after.fraction >= before.fraction - 1e-9, `${after.fraction} < ${before.fraction}`);
});

test('el tamano que llega tarde (lectura en segundo plano) no hace saltar la barra hacia atras', () => {
  const tracker = new BatchTracker();
  // Sin tamanos: pesan igual.
  const jobs = [job('image', 'done', undefined), job('image', 'pending', undefined), job('image', 'pending', undefined), job('image', 'pending', undefined)];
  const first = tracker.update(jobs, 3000).fraction;
  // Llegan los tamanos reales: la hecha era pequena, las pendientes enormes.
  jobs[0].size = 10; jobs[1].size = 1e6; jobs[2].size = 1e6; jobs[3].size = 1e6;
  assert.ok(tracker.update(jobs, 3100).fraction >= first);
});

test('el tiempo estimado es fiable: error < 20 % desde que hay datos suficientes (100 fotos, 4 a la vez)', () => {
  const tracker = new BatchTracker();
  const samples = [];
  const total = simulate({
    n: 100,
    onTick: (jobs, t) => {
      const r = tracker.update(jobs, t);
      if (r.etaMs !== null) samples.push({ t, eta: r.etaMs, fraction: r.fraction });
    }
  });
  assert.ok(samples.length > 0);
  // Desde el 25 % del lote: el fin predicho (t + eta) debe estar cerca del fin real.
  const late = samples.filter((s) => s.fraction >= 0.25 && s.fraction < 0.98);
  assert.ok(late.length > 20);
  for (const s of late) {
    const realRemaining = total - s.t;
    const error = Math.abs(s.eta - realRemaining) / realRemaining;
    // Al final del lote (ultimas fotos, con menos trabajadores activos) un error de un par de
    // segundos es inevitable y no engana a nadie: se tolera hasta 1,5 s absolutos.
    if (Math.abs(s.eta - realRemaining) < 1500) continue;
    assert.ok(error < 0.2, `a t=${s.t} ms (${Math.round(s.fraction * 100)} %) estimo ${s.eta} y faltaban ${realRemaining} (error ${Math.round(error * 100)} %)`);
  }
});

test('el tiempo estimado baja de forma regular: no da saltos grandes hacia arriba', () => {
  const tracker = new BatchTracker();
  let prev = null;
  let worstJump = 0;
  simulate({
    n: 120,
    // Mezcla de fotos pequenas y grandes: es lo que antes hacia saltar la cifra.
    sizeOf: (i) => (i % 5 === 0 ? 9_000_000 : 1_500_000),
    onTick: (jobs, t) => {
      const r = tracker.update(jobs, t);
      if (r.etaMs !== null && prev !== null && t > 8000) worstJump = Math.max(worstJump, r.etaMs - prev);
      if (r.etaMs !== null) prev = r.etaMs;
    }
  });
  assert.ok(worstJump < 3000, `la cuenta atras subio de golpe ${worstJump} ms`);
});

test('en pausa (el tiempo activo no avanza) la estimacion se queda quieta', () => {
  const tracker = new BatchTracker();
  const jobs = [];
  for (let i = 0; i < 6; i += 1) jobs.push(job('image', 'done', 100));
  for (let i = 0; i < 6; i += 1) jobs.push(job('image', 'pending', 100));
  tracker.update(jobs, 3000);
  const a = tracker.update(jobs, 6000).etaMs;
  const b = tracker.update(jobs, 6000).etaMs;
  assert.equal(a, b);
});
