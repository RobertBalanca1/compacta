'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { captureFfmpeg } = require('../src/main/processor/ffmpeg');
const A = require('../src/main/processor/audio-analysis');
const { makeAudio } = require('./helpers/make-audio');

test('un solo trozo: ffmpeg sin grafo de filtros; varios: UN solo ffmpeg que los junta (no un proceso por trozo)', () => {
  const one = A.buildChannelAnalysisArgs('in.wav', [{ start: 0, length: 12 }]);
  assert.ok(!one.includes('-filter_complex'));
  assert.equal(one.filter((a) => a === '-i').length, 1);

  const windows = [{ start: 0, length: 12 }, { start: 100, length: 12 }, { start: 200, length: 12 }];
  const many = A.buildChannelAnalysisArgs('in.wav', windows);
  assert.equal(many.filter((a) => a === '-i').length, 3, 'tres entradas, un único proceso');
  const graph = many[many.indexOf('-filter_complex') + 1];
  assert.match(graph, /concat=n=3:v=0:a=1\[out\]/);
  assert.equal((graph.match(/apad=whole_dur=12/g) || []).length, 3, 'cada trozo se rellena hasta su duración exacta');
  assert.equal(many[many.indexOf('-map') + 1], '[out]');
});

test('splitPcm reparte los trozos por igual y alineados a muestras estéreo de 16 bits (4 bytes)', () => {
  const parts = A.splitPcm(Buffer.alloc(4 * 9), 3);
  assert.deepEqual(parts.map((p) => p.length), [12, 12, 12]);
  const odd = A.splitPcm(Buffer.alloc(4 * 9 + 3), 3);
  assert.ok(odd.every((p) => p.length % 4 === 0));
});

test('REAL: un solo ffmpeg mide lo MISMO que uno por trozo (misma energía por trozo, mismos bytes)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compacta-anal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'largo.wav');
  makeAudio(file, { seconds: 700, rate: 8000, channels: 2, codecArgs: ['-c:a', 'pcm_s16le'] }); // > 600 s: 3 trozos
  const windows = A.sampleWindows(700);
  assert.equal(windows.length, 3);

  const separate = await Promise.all(windows.map(async (w) => A.stereoEnergies(
    await captureFfmpeg(['-ss', String(w.start), '-t', String(w.length), '-i', file, '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '16000', '-f', 's16le', 'pipe:1'])
  )));
  const pcm = await captureFfmpeg(A.buildChannelAnalysisArgs(file, windows));
  assert.equal(pcm.length, windows.length * windows[0].length * 16000 * 4, 'bytes exactos: nada se corta ni se alarga');
  const joined = A.splitPcm(pcm, windows.length).map(A.stereoEnergies);
  for (let i = 0; i < windows.length; i += 1) {
    for (const key of ['mid', 'side']) {
      const a = separate[i][key];
      const b = joined[i][key];
      assert.ok(Math.abs(a - b) <= Math.max(1e-9, a * 0.001), `trozo ${i}, ${key}: ${a} frente a ${b}`);
    }
  }
});

test('REAL: analyzeChannels decide igual con el método nuevo (dual mono -> mix; estéreo de verdad -> stereo)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compacta-anal2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dual = path.join(dir, 'dual.wav');
  const real = path.join(dir, 'real.wav');
  makeAudio(dual, { seconds: 200, rate: 8000, channels: 2, dualMono: true, codecArgs: ['-c:a', 'pcm_s16le'] });
  makeAudio(real, { seconds: 200, rate: 8000, channels: 2, codecArgs: ['-c:a', 'pcm_s16le'] });
  assert.equal((await A.analyzeChannels(dual, 200, -32)).mode, 'mix');
  assert.equal((await A.analyzeChannels(real, 200, -32)).mode, 'stereo');
});

test('un archivo ilegible no rompe el análisis: ante la duda, no se toca nada', async () => {
  const result = await A.analyzeChannels('/no/existe.wav', 100, -32);
  assert.equal(result.mode, 'stereo');
  assert.equal(await A.estimateKbps(() => ['-i', '/no/existe.wav', '-f', 'mp3', 'pipe:1'], 100), null);
});
