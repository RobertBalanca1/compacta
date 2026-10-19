'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { optimizeImage } = require('../src/main/processor/raster-optimizer');

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('PNG sin modo agresivo es pixel-perfecto (cero perdida real)', async () => {
  const dir = await makeTempDir('compacta-png-');
  const input = path.join(dir, 'in.png');
  const output = path.join(dir, 'out.png');
  const w = 200, h = 150;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37) % 256;
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 1 }).toFile(input);

  const report = await optimizeImage(input, output, { quality: 90, aggressive: false });
  assert.ok(report.newBytes <= report.originalBytes);

  const before = await sharp(input).raw().toBuffer();
  const after = await sharp(report.output).raw().toBuffer();
  assert.deepEqual(before, after, 'los pixeles deben ser identicos, byte a byte');

  await fs.rm(dir, { recursive: true, force: true });
});

test('nunca produce un archivo mas pesado que el original (salvaguarda)', async () => {
  const dir = await makeTempDir('compacta-safety-');
  const input = path.join(dir, 'in.png');
  const output = path.join(dir, 'out.png');
  const raw = Buffer.alloc(4 * 4 * 3, 128);
  await sharp(raw, { raw: { width: 4, height: 4, channels: 3 } }).png({ compressionLevel: 9 }).toFile(input);
  const originalStat = await fs.stat(input);

  const report = await optimizeImage(input, output, { quality: 90 });
  assert.ok(report.newBytes <= originalStat.size);
  assert.ok(await fs.stat(report.output).then((s) => s.size > 0));

  await fs.rm(dir, { recursive: true, force: true });
});

test('JPEG reduce el tamaño con la calidad por defecto', async () => {
  const dir = await makeTempDir('compacta-jpeg-');
  const input = path.join(dir, 'in.jpg');
  const output = path.join(dir, 'out.jpg');
  const w = 800, h = 600;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = Math.floor(128 + 60 * Math.sin(i / 97));
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 98 }).toFile(input);

  const report = await optimizeImage(input, output, { quality: 85 });
  assert.ok(report.newBytes < report.originalBytes);

  const meta = await sharp(report.output).metadata();
  assert.equal(meta.width, w);
  assert.equal(meta.height, h);

  await fs.rm(dir, { recursive: true, force: true });
});

test('no deja archivos .tmp- huerfanos tras una operacion exitosa', async () => {
  const dir = await makeTempDir('compacta-atomic-');
  const input = path.join(dir, 'in.png');
  const output = path.join(dir, 'out.png');
  await sharp({ create: { width: 30, height: 30, channels: 3, background: '#ffffff' } }).png().toFile(input);

  await optimizeImage(input, output, { quality: 90 });

  const files = await fs.readdir(dir);
  assert.equal(files.filter((f) => f.includes('.tmp-')).length, 0);

  await fs.rm(dir, { recursive: true, force: true });
});

test('produce un archivo de salida valido incluso en formato GIF', async () => {
  const dir = await makeTempDir('compacta-gif-');
  const input = path.join(dir, 'in.gif');
  const output = path.join(dir, 'out.gif');
  await sharp({ create: { width: 50, height: 50, channels: 3, background: '#336699' } }).gif().toFile(input);

  const report = await optimizeImage(input, output, { quality: 90 });
  const stat = await fs.stat(report.output);
  assert.ok(stat.size > 0);

  await fs.rm(dir, { recursive: true, force: true });
});

test('convertir a WebP un JPEG normal SI reduce el tamaño (regresion: antes quedaba sin cambios)', async () => {
  const dir = await makeTempDir('compacta-webp-jpeg-');
  const input = path.join(dir, 'in.jpg');
  const output = path.join(dir, 'out.jpg');
  const w = 1200, h = 900;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = Math.floor(128 + 50 * Math.sin(i / 53) + (Math.random() - 0.5) * 20);
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toFile(input);

  const report = await optimizeImage(input, output, { quality: 90, aggressive: false, convertToWebp: true });

  assert.equal(report.skipped, false, 'no debe caer en la salvaguarda de "sin mejora posible"');
  assert.ok(report.output.endsWith('.webp'), 'debe convertir la extension a .webp');
  assert.ok(report.newBytes < report.originalBytes, 'debe pesar menos que el jpg original');

  await fs.rm(dir, { recursive: true, force: true });
});

test('convertir un PNG a WebP sigue siendo sin perdida por defecto', async () => {
  const dir = await makeTempDir('compacta-webp-png-');
  const input = path.join(dir, 'in.png');
  const output = path.join(dir, 'out.png');
  await sharp({ create: { width: 300, height: 300, channels: 3, background: '#3366aa' } }).png().toFile(input);

  const report = await optimizeImage(input, output, { quality: 90, aggressive: false, convertToWebp: true });
  assert.ok(report.output.endsWith('.webp'));

  const pixelsBefore = await sharp(input).raw().toBuffer();
  const pixelsAfter = await sharp(report.output).raw().toBuffer();
  assert.deepEqual(pixelsBefore, pixelsAfter, 'PNG a WebP sin modo agresivo debe seguir siendo pixel-perfecto');

  await fs.rm(dir, { recursive: true, force: true });
});

test('modo agresivo produce un resultado distinto en JPEG (regresion: antes era un no-op)', async () => {
  const dir = await makeTempDir('compacta-aggressive-jpeg-');
  const input = path.join(dir, 'in.jpg');
  const w = 1200, h = 900;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = Math.floor(128 + 50 * Math.sin(i / 53) + (Math.random() - 0.5) * 20);
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toFile(input);

  const normal = await optimizeImage(input, path.join(dir, 'normal.jpg'), { quality: 90, aggressive: false });
  const aggressive = await optimizeImage(input, path.join(dir, 'aggressive.jpg'), { quality: 90, aggressive: true });

  assert.notEqual(normal.newBytes, aggressive.newBytes, 'agresivo debe dar un resultado distinto (mas comprimido) que el modo normal');
  assert.ok(aggressive.newBytes < normal.newBytes, 'agresivo debe pesar menos que el modo normal');

  await fs.rm(dir, { recursive: true, force: true });
});
