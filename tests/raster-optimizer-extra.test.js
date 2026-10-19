'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { optimizeImage } = require('../src/main/processor/raster-optimizer');

async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('dos fotos con el mismo nombre y distinta extension NO se pisan entre si', async () => {
  const dir = await tmpDir('compacta-clash-');
  const outDir = path.join(dir, 'out');
  await fs.mkdir(outDir, { recursive: true });

  const jpgIn = path.join(dir, 'foto.jpg');
  const pngIn = path.join(dir, 'foto.png');
  await sharp({ create: { width: 300, height: 200, channels: 3, background: '#ff0000' } }).jpeg().toFile(jpgIn);
  await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } }).png().toFile(pngIn);

  // Con "Convertir a WebP" activo, sin la correccion ambas terminan pidiendo
  // escribir out/foto.webp: la segunda pisaria a la primera en silencio.
  const settings = { quality: 90, aggressive: false, convertToWebp: true };
  const r1 = await optimizeImage(jpgIn, path.join(outDir, 'foto.jpg'), settings);
  const r2 = await optimizeImage(pngIn, path.join(outDir, 'foto.png'), settings);

  assert.notEqual(r1.output, r2.output, 'deben terminar en archivos de salida distintos');
  const files = await fs.readdir(outDir);
  assert.equal(files.length, 2, `deben quedar 2 archivos en output/, hay: ${files.join(', ')}`);

  await fs.rm(dir, { recursive: true, force: true });
});

test('sin colision de nombres, el resultado no lleva sufijo (no cambia el comportamiento normal)', async () => {
  const dir = await tmpDir('compacta-clash2-');
  const outDir = path.join(dir, 'out');
  await fs.mkdir(outDir, { recursive: true });
  const jpgIn = path.join(dir, 'unica.jpg');
  await sharp({ create: { width: 300, height: 200, channels: 3, background: '#0000ff' } }).jpeg().toFile(jpgIn);

  const r = await optimizeImage(jpgIn, path.join(outDir, 'unica.jpg'), { quality: 90 });
  assert.equal(path.basename(r.output), 'unica.jpg');

  await fs.rm(dir, { recursive: true, force: true });
});

test('optimizeImage no revienta si le llegan ajustes invalidos (calidad no numerica)', async () => {
  const dir = await tmpDir('compacta-badopts-');
  const outDir = path.join(dir, 'out');
  await fs.mkdir(outDir, { recursive: true });
  const jpgIn = path.join(dir, 'foto.jpg');
  await sharp({ create: { width: 300, height: 200, channels: 3, background: '#123456' } }).jpeg().toFile(jpgIn);

  const report = await optimizeImage(jpgIn, path.join(outDir, 'foto.jpg'), { quality: 'no-es-un-numero' });
  assert.ok(report && report.output, 'debe usar un valor por defecto razonable en vez de fallar');

  await fs.rm(dir, { recursive: true, force: true });
});
