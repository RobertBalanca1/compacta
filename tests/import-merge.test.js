'use strict';

// Volver a soltar una carpeta (o un comprimido) con un nombre que ya se importo: se UNE a la carpeta de siempre en
// vez de crear "Fotos (2)", "Fotos (3)"... (antes input/ y output/ se llenaban de carpetas con numero).

const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

process.env.COMPACTA_TEST_BASE_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'compacta-merge-base-'));

const sharp = require('sharp');
const { makeZip } = require('./helpers/make-zip');
const { importPaths } = require('../src/main/importer');
const { saveSettings } = require('../src/main/settings-store');
const { getInputDir } = require('../src/main/paths');
const { resetSharedIndexes } = require('../src/main/duplicates');

const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), `compacta-merge-${p}-`));
const photo = (color) => sharp({ create: { width: 24, height: 24, channels: 3, background: color } }).jpeg().toBuffer();
const topLevel = async () => (await fs.readdir(getInputDir())).sort();
const inside = async (...parts) => (await fs.readdir(path.join(getInputDir(), ...parts))).sort();

test.beforeEach(async () => {
  saveSettings({ skipDuplicates: true });
  resetSharedIndexes();
  await fs.rm(getInputDir(), { recursive: true, force: true });
});

test('soltar OTRA VEZ la misma carpeta no crea "Pruebas (2)": todo era repetido y no queda nada nuevo', async () => {
  const src = await tmp('same');
  await fs.mkdir(path.join(src, 'Pruebas'));
  await fs.writeFile(path.join(src, 'Pruebas', 'a.jpg'), await photo('#aa3300'));
  await fs.writeFile(path.join(src, 'Pruebas', 'b.jpg'), await photo('#00aa33'));

  const first = await importPaths([path.join(src, 'Pruebas')], { isLive: async () => true });
  const second = await importPaths([path.join(src, 'Pruebas')], { isLive: async () => true });

  assert.equal(first.importedFiles.length, 2);
  assert.equal(second.importedFiles.length, 0);
  assert.equal(second.duplicateCount, 2);
  assert.deepEqual(await topLevel(), ['Pruebas'], 'una sola carpeta, sin número');
  assert.deepEqual(await inside('Pruebas'), ['a.jpg', 'b.jpg'], 'y sin "a (2).jpg" sobrantes: los repetidos se descartaron');
  await fs.rm(src, { recursive: true, force: true });
});

test('una carpeta con el mismo nombre pero fotos NUEVAS se une a la de antes (y lo que se llama igual pero es distinto no se pisa)', async () => {
  const src1 = await tmp('one');
  const src2 = await tmp('two');
  await fs.mkdir(path.join(src1, 'Boda'));
  await fs.mkdir(path.join(src2, 'Boda'));
  const original = await photo('#112233');
  const different = await photo('#ddeeff');
  await fs.writeFile(path.join(src1, 'Boda', 'IMG_1.jpg'), original);
  await fs.writeFile(path.join(src2, 'Boda', 'IMG_1.jpg'), different); // otra foto con el MISMO nombre (la cámara reinició la cuenta)
  await fs.writeFile(path.join(src2, 'Boda', 'IMG_2.jpg'), await photo('#445566'));

  await importPaths([path.join(src1, 'Boda')]);
  const second = await importPaths([path.join(src2, 'Boda')]);

  assert.equal(second.importedFiles.length, 2);
  assert.deepEqual(await topLevel(), ['Boda']);
  assert.deepEqual(await inside('Boda'), ['IMG_1 (2).jpg', 'IMG_1.jpg', 'IMG_2.jpg']);
  assert.deepEqual(await fs.readFile(path.join(getInputDir(), 'Boda', 'IMG_1.jpg')), original, 'la foto de antes no se tocó');
  assert.deepEqual(await fs.readFile(path.join(getInputDir(), 'Boda', 'IMG_1 (2).jpg')), different);
  await fs.rm(src1, { recursive: true, force: true });
  await fs.rm(src2, { recursive: true, force: true });
});

test('las subcarpetas también se unen (Viaje/Dia1 existía y llegan más fotos a Viaje/Dia1)', async () => {
  const src = await tmp('sub');
  await fs.mkdir(path.join(src, 'Viaje', 'Dia1'), { recursive: true });
  await fs.writeFile(path.join(src, 'Viaje', 'Dia1', 'a.jpg'), await photo('#abcdef'));
  await importPaths([path.join(src, 'Viaje')]);
  await fs.writeFile(path.join(src, 'Viaje', 'Dia1', 'b.jpg'), await photo('#fedcba'));

  const second = await importPaths([path.join(src, 'Viaje')]);

  assert.equal(second.importedFiles.length, 1, 'solo la foto nueva (a.jpg ya estaba)');
  assert.deepEqual(await topLevel(), ['Viaje']);
  assert.deepEqual(await inside('Viaje'), ['Dia1']);
  assert.deepEqual(await inside('Viaje', 'Dia1'), ['a.jpg', 'b.jpg']);
  await fs.rm(src, { recursive: true, force: true });
});

test('un video renombrado al unirse lleva consigo su subtítulo (y el de antes no se toca)', async () => {
  saveSettings({ skipDuplicates: false });
  const src = await tmp('video');
  await fs.mkdir(path.join(src, 'Pelis'));
  await fs.writeFile(path.join(src, 'Pelis', 'Clip.mp4'), Buffer.from('video de prueba'));
  await fs.writeFile(path.join(src, 'Pelis', 'Clip.es.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhola\n');
  await importPaths([path.join(src, 'Pelis')]);
  await importPaths([path.join(src, 'Pelis')]);

  assert.deepEqual(await topLevel(), ['Pelis']);
  assert.deepEqual(await inside('Pelis'), ['Clip (2).es.srt', 'Clip (2).mp4', 'Clip.es.srt', 'Clip.mp4']);
  await fs.rm(src, { recursive: true, force: true });
});

test('un comprimido que se llama como una carpeta existente se une a ella; uno sin fotos NO borra esa carpeta', async () => {
  saveSettings({ skipDuplicates: false });
  const src = await tmp('zip');
  await fs.mkdir(path.join(getInputDir(), 'Datos'), { recursive: true });
  await fs.writeFile(path.join(getInputDir(), 'Datos', 'mia.jpg'), await photo('#123456'));

  await fs.writeFile(path.join(src, 'Datos.zip'), makeZip([{ name: 'nueva.jpg', data: await photo('#654321') }]));
  const merged = await importPaths([path.join(src, 'Datos.zip')]);
  assert.equal(merged.importedFiles.length, 1);
  assert.deepEqual(await topLevel(), ['Datos'], 'sin "Datos (2)"');
  assert.deepEqual(await inside('Datos'), ['mia.jpg', 'nueva.jpg']);

  await fs.writeFile(path.join(src, 'Datos.zip'), makeZip([{ name: 'leeme.txt', data: 'sin fotos' }]));
  const empty = await importPaths([path.join(src, 'Datos.zip')]);
  assert.equal(empty.importedFiles.length, 0);
  assert.deepEqual(await inside('Datos'), ['mia.jpg', 'nueva.jpg'], 'la carpeta de antes sigue intacta');
  await fs.rm(src, { recursive: true, force: true });
});

test('una carpeta NUEVA que no existía sigue creándose normal, y un comprimido sin fotos no deja carpeta vacía', async () => {
  const src = await tmp('fresh');
  await fs.writeFile(path.join(src, 'Solo-texto.zip'), makeZip([{ name: 'leeme.txt', data: 'x' }]));
  await importPaths([path.join(src, 'Solo-texto.zip')]);
  assert.deepEqual(await topLevel(), [], 'nada que dejar');
  await fs.mkdir(path.join(src, 'Nueva'));
  await fs.writeFile(path.join(src, 'Nueva', 'a.jpg'), await photo('#777777'));
  await importPaths([path.join(src, 'Nueva')]);
  assert.deepEqual(await topLevel(), ['Nueva']);
  await fs.rm(src, { recursive: true, force: true });
});

test('dos importaciones A LA VEZ con el mismo nombre de carpeta y los mismos nombres de archivo: no se pisan', async () => {
  saveSettings({ skipDuplicates: false });
  const a = await tmp('conc-a');
  const b = await tmp('conc-b');
  const colors = ['#101010', '#202020', '#303030', '#404040', '#505050', '#606060'];
  for (const [dir, offset] of [[a, 0], [b, 3]]) {
    await fs.mkdir(path.join(dir, 'Fotos'));
    for (let i = 0; i < 3; i += 1) await fs.writeFile(path.join(dir, 'Fotos', `IMG_${i}.jpg`), await photo(colors[offset + i]));
  }
  const [ra, rb] = await Promise.all([importPaths([path.join(a, 'Fotos')]), importPaths([path.join(b, 'Fotos')])]);

  assert.equal(ra.importedFiles.length + rb.importedFiles.length, 6);
  assert.equal(new Set([...ra.importedFiles, ...rb.importedFiles]).size, 6, 'seis archivos distintos');
  assert.deepEqual(await topLevel(), ['Fotos']);
  assert.equal((await inside('Fotos')).length, 6, 'ninguna foto pisó a otra');
  const bytes = new Set();
  for (const name of await inside('Fotos')) bytes.add((await fs.readFile(path.join(getInputDir(), 'Fotos', name))).toString('base64'));
  assert.equal(bytes.size, 6, 'y cada una conserva su contenido');
  await fs.rm(a, { recursive: true, force: true });
  await fs.rm(b, { recursive: true, force: true });
});

test('al unirse a una carpeta, foto.png que YA estaba y foto.jpg que llega: la salida no las confunde', async () => {
  const { chooseOutputPath, releaseSiblings } = require('../src/main/processor/output-files');
  saveSettings({ skipDuplicates: false });
  const src = await tmp('sib');
  await fs.mkdir(path.join(src, 'Mix'));
  await fs.writeFile(path.join(src, 'Mix', 'foto.png'), await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ff0000' } }).png().toBuffer());
  await importPaths([path.join(src, 'Mix')]);
  await fs.rm(path.join(src, 'Mix', 'foto.png'));
  await fs.writeFile(path.join(src, 'Mix', 'foto.jpg'), await photo('#0000ff'));

  const names = [];
  await importPaths([path.join(src, 'Mix')], {
    onFiles: async (files) => { for (const f of files) names.push(path.basename(await chooseOutputPath(f, path.join(await tmp('o'), path.basename(f))))); }
  });
  assert.deepEqual(names, ['foto_jpg.jpg'], 'sabe que foto.png ya existe en la carpeta aunque no venga en esta tanda');
  releaseSiblings(path.join(getInputDir(), 'Mix'));
  await fs.rm(src, { recursive: true, force: true });
});
