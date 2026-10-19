'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { buildPreview, buildDetail, PREVIEW_MAX_SIDE, DETAIL_MAX_SIDE } = require('../src/main/preview');
const { optimizeImage } = require('../src/main/processor/raster-optimizer');
const { optimizeVideo } = require('../src/main/processor/video-optimizer');
const { makeVideo } = require('./helpers/make-video');

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'compacta-prev-'));
const decode = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');

async function processed(dir, name, options = {}, make) {
  const input = path.join(dir, name);
  await (make || (() => sharp({ create: { width: 3000, height: 2000, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 45 } } }).jpeg({ quality: 96 }).toFile(input)))(input);
  const report = await optimizeImage(input, path.join(dir, 'out', name), { quality: 85, ...options });
  return { kind: 'image', status: 'done', inputPath: input, report };
}

test('la vista previa nunca manda la foto completa: se reduce a 1400 px y sale como JPEG', async () => {
  const dir = await tmp();
  const job = await processed(dir, 'grande.jpg');
  const { before, after } = await buildPreview(job);

  for (const side of [before, after]) {
    assert.match(side.dataUrl, /^data:image\/jpeg;base64,/);
    const meta = await sharp(decode(side.dataUrl)).metadata();
    assert.ok(Math.max(meta.width, meta.height) <= PREVIEW_MAX_SIDE, `reducida: ${meta.width}x${meta.height}`);
    assert.equal(side.width, 3000, 'pero informa de las medidas REALES del archivo');
    assert.equal(side.height, 2000);
  }
  assert.equal(before.bytes, (await fs.stat(job.inputPath)).size);
  assert.equal(after.bytes, (await fs.stat(job.report.output)).size);
  assert.ok(after.bytes < before.bytes);
  await fs.rm(dir, { recursive: true, force: true });
});

test('una foto pequena no se agranda', async () => {
  const dir = await tmp();
  const job = await processed(dir, 'chica.jpg', {}, (p) => sharp({ create: { width: 300, height: 200, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 45 } } }).jpeg({ quality: 96 }).toFile(p));
  const { before } = await buildPreview(job);
  assert.equal(before.previewWidth, 300);
  await fs.rm(dir, { recursive: true, force: true });
});

test('respeta la orientacion EXIF: una foto de movil en vertical NO sale de lado', async () => {
  const dir = await tmp();
  // 3000x2000 almacenada apaisada pero con orientacion 6 (girar 90 grados): se ve 2000x3000.
  const job = await processed(dir, 'movil.jpg', {}, (p) => sharp({ create: { width: 3000, height: 2000, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 45 } } }).jpeg({ quality: 96 }).withMetadata({ orientation: 6 }).toFile(p));
  const { before } = await buildPreview(job);
  const meta = await sharp(decode(before.dataUrl)).metadata();
  assert.ok(meta.height > meta.width, `debe verse vertical: ${meta.width}x${meta.height}`);
  assert.equal(before.width, 2000, 'las medidas informadas ya son las de como se ve');
  assert.equal(before.height, 3000);
  await fs.rm(dir, { recursive: true, force: true });
});

test('si la salida es de otro formato (WebP), tambien se compara', async () => {
  const dir = await tmp();
  const job = await processed(dir, 'conv.jpg', { convertToWebp: true });
  assert.ok(job.report.output.endsWith('.webp'));
  const { after } = await buildPreview(job);
  assert.match(after.dataUrl, /^data:image\/jpeg/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('errores con mensaje para la persona: video, sin terminar, archivo borrado, archivo roto', async () => {
  await assert.rejects(() => buildPreview({ kind: 'image', status: 'pending' }), /todavía no está procesada/);
  await assert.rejects(() => buildPreview(undefined), /No se encuentra/);

  const dir = await tmp();
  const job = await processed(dir, 'x.jpg');
  await fs.rm(job.inputPath);
  await assert.rejects(() => buildPreview(job), /No se encuentra el archivo/);

  const broken = path.join(dir, 'roto.jpg');
  await fs.writeFile(broken, 'no soy una foto');
  await assert.rejects(() => buildPreview({ kind: 'image', status: 'done', inputPath: broken, report: { output: broken } }), /No se pudo preparar/);
  await fs.rm(dir, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// Detalle al 100 % (1.0.10)
// ---------------------------------------------------------------------------

test('detalle al 100 %: devuelve el recorte pedido SIN reducir, de las dos fotos y en PNG', async () => {
  const dir = await tmp();
  const job = await processed(dir, 'detalle.jpg');
  const { before, after, region, imageWidth, imageHeight } = await buildDetail(job, { cx: 0.5, cy: 0.5, width: 800, height: 600 });
  assert.equal(imageWidth, 3000);
  assert.equal(imageHeight, 2000);
  assert.deepEqual({ w: region.width, h: region.height }, { w: 800, h: 600 });
  for (const side of [before, after]) {
    assert.match(side, /^data:image\/png;base64,/);
    const meta = await sharp(decode(side)).metadata();
    assert.equal(meta.width, 800, 'tamano real, sin reducir');
    assert.equal(meta.height, 600);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('detalle: pedir una zona en una esquina o mas grande que la foto se acota, nunca se sale', async () => {
  const dir = await tmp();
  const job = await processed(dir, 'esquina.jpg', {}, (p) => sharp({ create: { width: 500, height: 400, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 45 } } }).jpeg({ quality: 96 }).toFile(p));
  const corner = await buildDetail(job, { cx: 1, cy: 1, width: 300, height: 200 });
  assert.equal(corner.region.left + corner.region.width, 500);
  assert.equal(corner.region.top + corner.region.height, 400);
  const huge = await buildDetail(job, { cx: 0.5, cy: 0.5, width: 99999, height: 99999 });
  assert.equal(huge.region.width, 500, 'no pasa de la foto');
  assert.equal(huge.region.height, 400);
  const junk = await buildDetail(job, { cx: 'x', cy: NaN, width: -5, height: {} });
  assert.ok(junk.region.width >= 64 && junk.region.width <= DETAIL_MAX_SIDE, 'valores raros no rompen nada');
  await fs.rm(dir, { recursive: true, force: true });
});

test('detalle: con orientacion EXIF la zona se mide sobre la foto COMO SE VE (no de lado)', async () => {
  const dir = await tmp();
  // Almacenada 600x400 con orientacion 6 (se ve 400x600). Mitad izquierda almacenada roja, derecha azul.
  const make = (p) => sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 0, g: 0, b: 255 } } })
    .composite([{ input: { create: { width: 300, height: 400, channels: 3, background: { r: 255, g: 0, b: 0 } } }, left: 0, top: 0 }])
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).withMetadata({ orientation: 6 }).toFile(p);
  const job = await processed(dir, 'girada.jpg', { quality: 100 }, make);
  const top = await buildDetail(job, { cx: 0.5, cy: 0.1, width: 100, height: 100 });
  const bottom = await buildDetail(job, { cx: 0.5, cy: 0.9, width: 100, height: 100 });
  assert.equal(top.imageWidth, 400);
  assert.equal(top.imageHeight, 600);
  const px = async (url) => (await sharp(decode(url)).raw().toBuffer()).subarray(0, 3);
  // Girada 90 grados a la derecha, la mitad roja (izquierda) queda ARRIBA.
  const t = await px(top.before);
  const b = await px(bottom.before);
  assert.ok(t[0] > 200 && t[2] < 60, `arriba debe ser rojo: ${[...t]}`);
  assert.ok(b[2] > 200 && b[0] < 60, `abajo debe ser azul: ${[...b]}`);
  await fs.rm(dir, { recursive: true, force: true });
});

test('detalle: un video o una foto sin terminar no tienen detalle', async () => {
  await assert.rejects(() => buildDetail({ kind: 'video', status: 'done', report: {} }, {}), /solo para fotos/);
  await assert.rejects(() => buildDetail({ kind: 'image', status: 'pending' }, {}), /todavía no está procesada/);
});


test('VIDEO: la vista previa compara un fotograma del original y del resultado (sin reproducir nada)', async () => {
  const dir = await tmp();
  const input = path.join(dir, 'clip.mp4');
  makeVideo(input, { seconds: 3, size: '640x360' });
  const report = await optimizeVideo(input, path.join(dir, 'out', 'clip.mp4'), { quality: 80 });
  const { before, after, video } = await buildPreview({ kind: 'video', status: 'done', inputPath: input, report });
  assert.equal(video, true);
  for (const side of [before, after]) {
    assert.match(side.dataUrl, /^data:image\/jpeg;base64,/);
    const meta = await sharp(decode(side.dataUrl)).metadata();
    assert.equal(meta.width, 640);
    assert.equal(meta.height, 360);
    assert.equal(side.width, 640, 'medidas reales del video');
  }
  assert.equal(before.bytes, (await fs.stat(input)).size);
  assert.equal(after.bytes, (await fs.stat(report.output)).size);
  // Sin restos: el fotograma temporal se borra.
  const leftovers = (await fs.readdir(require('os').tmpdir())).filter((n) => n.startsWith('compacta-frame-'));
  assert.deepEqual(leftovers, []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('VIDEO: un video sin terminar o un archivo que ya no existe da un mensaje claro', async () => {
  await assert.rejects(() => buildPreview({ kind: 'video', status: 'pending' }), /vídeo todavía no está procesado/);
  await assert.rejects(() => buildPreview({ kind: 'video', status: 'done', inputPath: '/no/existe.mp4', report: { output: '/no/existe2.mp4' } }), /fotograma|No se encuentra/);
});
