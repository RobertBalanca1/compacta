'use strict';

// Importacion de VARIAS carpetas, de .zip sueltos y de .zip dentro de
// carpetas, con entrega progresiva (carpeta a carpeta) a la cola.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { makeZip } = require('./helpers/make-zip');
const { importPaths } = require('../src/main/importer');
const { getInputDir } = require('../src/main/paths');

async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `compacta-${prefix}-`));
}
async function jpeg(color = '#336699') {
  return sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).jpeg().toBuffer();
}
const rel = (p) => path.relative(getInputDir(), p).split(path.sep).join('/');

// Esta prueba no es sobre duplicados: importa a proposito el mismo archivo
// sintetico una y otra vez. La deteccion se prueba en duplicates.test.js.
require('../src/main/settings-store').saveSettings({ skipDuplicates: false });

test('varias carpetas a la vez con el MISMO nombre: se unen en una sola carpeta y ninguna foto pisa a otra', async () => {
  const src = await tmpDir('multi');
  const img = await jpeg();
  for (const dir of ['A/Fotos', 'B/Fotos']) {
    await fs.mkdir(path.join(src, dir), { recursive: true });
    await fs.writeFile(path.join(src, dir, 'x.jpg'), img);
  }
  // Las dos carpetas se llaman "Fotos": se unen en input/Fotos (ya no aparece "Fotos (2)"), y como las dos traen
  // un x.jpg, el segundo se llama "x (2).jpg" para no pisar al primero.
  const result = await importPaths([path.join(src, 'A', 'Fotos'), path.join(src, 'B', 'Fotos')]);

  const names = result.importedFiles.map(rel).sort();
  assert.equal(names.length, 2);
  assert.deepEqual(names, ['Fotos/x (2).jpg', 'Fotos/x.jpg']);
  assert.deepEqual((await fs.readdir(getInputDir())).filter((n) => n.startsWith('Fotos')), ['Fotos'], 'una sola carpeta, sin número');
  await fs.rm(src, { recursive: true, force: true });
});

test('un .zip suelto se descomprime en su propia carpeta y sus imagenes se importan', async () => {
  const src = await tmpDir('zipdrop');
  const img = await jpeg();
  const zipPath = path.join(src, 'Boda-2026.zip');
  await fs.writeFile(zipPath, makeZip([
    { name: 'a.jpg', data: img },
    { name: 'dia/b.jpg', data: img },
    { name: 'leeme.txt', data: 'x' }
  ]));

  const result = await importPaths([zipPath]);

  assert.equal(result.importedFiles.length, 2);
  assert.ok(result.importedFiles.every((f) => rel(f).startsWith('Boda-2026')), 'dentro de input/Boda-2026*');
  assert.equal(result.archiveCount, 1);
  assert.equal(result.skippedCount, 1, 'leeme.txt');
  assert.deepEqual(result.failedArchives, []);
  await fs.rm(src, { recursive: true, force: true });
});

test('un .zip dentro de una carpeta tambien se descomprime, junto a sus fotos sueltas', async () => {
  const src = await tmpDir('zipinfolder');
  const img = await jpeg();
  await fs.mkdir(path.join(src, 'Cliente'), { recursive: true });
  await fs.writeFile(path.join(src, 'Cliente', 'suelta.jpg'), img);
  await fs.writeFile(path.join(src, 'Cliente', 'extra.zip'), makeZip([{ name: 'dentro.jpg', data: img }]));

  const result = await importPaths([path.join(src, 'Cliente')]);

  const names = result.importedFiles.map(rel).map((n) => n.replace(/ \(\d+\)/, '')).sort();
  assert.deepEqual(names, ['Cliente/extra/dentro.jpg', 'Cliente/suelta.jpg']);
  await fs.rm(src, { recursive: true, force: true });
});

test('carpeta + zip + archivo suelto en una sola importacion', async () => {
  const src = await tmpDir('mezcla');
  const img = await jpeg();
  await fs.mkdir(path.join(src, 'Dir'), { recursive: true });
  await fs.writeFile(path.join(src, 'Dir', '1.jpg'), img);
  await fs.writeFile(path.join(src, 'pack.zip'), makeZip([{ name: '2.jpg', data: img }]));
  await fs.writeFile(path.join(src, 'suelta.jpg'), img);

  const result = await importPaths([path.join(src, 'Dir'), path.join(src, 'pack.zip'), path.join(src, 'suelta.jpg')]);

  assert.equal(result.importedFiles.length, 3);
  await fs.rm(src, { recursive: true, force: true });
});

test('onFiles entrega carpeta a carpeta, y siempre con la carpeta COMPLETA ya copiada', async () => {
  const src = await tmpDir('progresivo');
  const img = await jpeg();
  for (const sub of ['uno', 'dos', 'tres']) {
    await fs.mkdir(path.join(src, 'Raiz', sub), { recursive: true });
    for (let i = 0; i < 5; i += 1) await fs.writeFile(path.join(src, 'Raiz', sub, `f${i}.jpg`), img);
  }
  const deliveries = [];

  const result = await importPaths([path.join(src, 'Raiz')], {
    onFiles: async (files) => {
      // Cuando llega la entrega, TODOS sus archivos ya existen en disco.
      for (const f of files) await fs.access(f);
      deliveries.push(files.length);
    }
  });

  assert.deepEqual(deliveries, [5, 5, 5], 'tres entregas, una por carpeta, no una sola al final');
  assert.equal(result.importedFiles.length, 15);
  await fs.rm(src, { recursive: true, force: true });
});

test('el orden de las fotos importadas se conserva aunque se copien en paralelo', async () => {
  const src = await tmpDir('orden');
  const img = await jpeg();
  await fs.mkdir(path.join(src, 'Orden'), { recursive: true });
  for (let i = 0; i < 40; i += 1) await fs.writeFile(path.join(src, 'Orden', `foto${String(i).padStart(2, '0')}.jpg`), img);

  const { importedFiles } = await importPaths([path.join(src, 'Orden')]);

  const names = importedFiles.map((f) => path.basename(f));
  assert.deepEqual(names, [...names].sort(), 'mismo orden que en la carpeta origen (alfabetico)');
  await fs.rm(src, { recursive: true, force: true });
});

test('dos archivos sueltos con el mismo nombre desde carpetas distintas no se pisan', async () => {
  const src = await tmpDir('sueltos');
  await fs.mkdir(path.join(src, 'x'));
  await fs.mkdir(path.join(src, 'y'));
  await fs.writeFile(path.join(src, 'x', 'IMG_001.jpg'), await jpeg('#ff0000'));
  await fs.writeFile(path.join(src, 'y', 'IMG_001.jpg'), await jpeg('#0000ff'));

  const { importedFiles } = await importPaths([path.join(src, 'x', 'IMG_001.jpg'), path.join(src, 'y', 'IMG_001.jpg')]);

  assert.equal(importedFiles.length, 2);
  assert.equal(new Set(importedFiles.map((f) => path.basename(f).toLowerCase())).size, 2, 'nombres distintos en el lote');
  await fs.rm(src, { recursive: true, force: true });
});

test('un ZIP roto no impide importar el resto, y se informa', async () => {
  const src = await tmpDir('zip-roto');
  const img = await jpeg();
  await fs.writeFile(path.join(src, 'malo.zip'), Buffer.from('basura'));
  await fs.writeFile(path.join(src, 'ok.jpg'), img);

  const result = await importPaths([path.join(src, 'malo.zip'), path.join(src, 'ok.jpg')]);

  assert.equal(result.importedFiles.length, 1);
  assert.equal(result.failedArchives.length, 1);
  assert.equal(result.failedArchives[0].name, 'malo.zip');
  await fs.rm(src, { recursive: true, force: true });
});

test('importar una lista muy grande no revienta la pila (sin push(...lista))', async () => {
  const src = await tmpDir('grande');
  await fs.mkdir(path.join(src, 'Mil'), { recursive: true });
  const tiny = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
  for (let i = 0; i < 1500; i += 1) await fs.writeFile(path.join(src, 'Mil', `f${i}.jpg`), tiny);

  const { importedFiles } = await importPaths([path.join(src, 'Mil')]);

  assert.equal(importedFiles.length, 1500);
  await fs.rm(src, { recursive: true, force: true });
});
