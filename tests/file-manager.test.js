'use strict';

// Estas pruebas usan app.getPath (via src/main/paths.js), pero paths.js
// cae automaticamente a una carpeta temporal cuando no hay Electron real
// corriendo, asi que se ejecutan con `node --test` normal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

// Esta prueba no es sobre duplicados: importa a proposito el mismo archivo
// sintetico una y otra vez. La deteccion se prueba en duplicates.test.js.
require('../src/main/settings-store').saveSettings({ skipDuplicates: false });

test('importPaths detecta archivos no compatibles sueltos (por ejemplo .psd) y los reporta', async () => {
  const { importPaths } = require('../src/main/importer');

  const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-heic-'));
  const psdPath = path.join(srcDir, 'diseno.PSD');
  await fs.writeFile(psdPath, Buffer.from('esto no es una imagen real, solo se prueba la deteccion por extension'));

  const { importedFiles, skippedCount, skippedExtensions } = await importPaths([psdPath]);

  assert.equal(importedFiles.length, 0, 'un .psd no debe importarse (formato no soportado por el motor)');
  assert.equal(skippedCount, 1);
  assert.ok(skippedExtensions.includes('.psd'), 'debe reportar la extension .psd para poder avisarle al usuario');

  await fs.rm(srcDir, { recursive: true, force: true });
});

test('importPaths detecta lo no compatible dentro de una carpeta importada (no solo archivos sueltos)', async () => {
  const { importPaths } = require('../src/main/importer');

  const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-heic-carpeta-'));
  await fs.mkdir(path.join(srcDir, 'FotosDelCelular'), { recursive: true });
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ff00ff' } })
    .jpeg().toFile(path.join(srcDir, 'FotosDelCelular', 'a.jpg'));
  await fs.writeFile(path.join(srcDir, 'FotosDelCelular', 'b.bmp'), Buffer.from('contenido de prueba, no una imagen real'));

  const { importedFiles, skippedCount, skippedExtensions } = await importPaths([path.join(srcDir, 'FotosDelCelular')]);

  assert.equal(importedFiles.length, 1, 'debe importar la unica foto compatible (a.jpg)');
  assert.equal(skippedCount, 1, 'debe contar b.bmp como no importado, no ignorarlo en silencio');
  assert.ok(skippedExtensions.includes('.bmp'));

  await fs.rm(srcDir, { recursive: true, force: true });
});

test('importPaths acepta fotos .heic/.heif (iPhone): ya se importan como cualquier foto', async () => {
  const { importPaths } = require('../src/main/importer');
  const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-heic-ok-'));
  await fs.writeFile(path.join(srcDir, 'IMG_9999.HEIC'), Buffer.from('contenido de prueba'));
  await fs.writeFile(path.join(srcDir, 'IMG_9998.heif'), Buffer.from('contenido de prueba 2'));
  const { importedFiles, skippedCount } = await importPaths([srcDir]);
  assert.equal(importedFiles.length, 2);
  assert.equal(skippedCount, 0, 'ya no son «formato no compatible»');
  await fs.rm(srcDir, { recursive: true, force: true });
});

test('importPaths refleja la estructura de subcarpetas y solo copia imagenes', async () => {
  const { importPaths } = require('../src/main/importer');
  const { listBatches } = require('../src/main/file-manager');
  const { getInputDir } = require('../src/main/paths');

  const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-src-'));
  await fs.mkdir(path.join(srcDir, 'Viaje', 'Dia1'), { recursive: true });
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ff0000' } })
    .jpeg().toFile(path.join(srcDir, 'Viaje', 'a.jpg'));
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#00ff00' } })
    .jpeg().toFile(path.join(srcDir, 'Viaje', 'Dia1', 'b.jpg'));
  await fs.writeFile(path.join(srcDir, 'Viaje', 'notas.txt'), 'esto no es una imagen');

  const { importedFiles } = await importPaths([path.join(srcDir, 'Viaje')]);
  assert.equal(importedFiles.length, 2, 'debe importar solo las 2 imagenes, no el .txt');

  const relativePaths = importedFiles.map((f) => path.relative(getInputDir(), f));
  assert.ok(relativePaths.includes(path.join('Viaje', 'a.jpg')));
  assert.ok(relativePaths.includes(path.join('Viaje', 'Dia1', 'b.jpg')));

  const second = await importPaths([path.join(srcDir, 'Viaje')]);
  assert.equal(second.importedFiles.length, 2);
  const batches = await listBatches();
  const viajeBatches = batches.filter((b) => b.name.startsWith('Viaje'));
  assert.equal(viajeBatches.length, 1, 'la segunda importacion se une a "Viaje": ya no crea "Viaje (2)"');
  const secondNames = second.importedFiles.map((f) => path.relative(getInputDir(), f)).sort();
  assert.deepEqual(secondNames, [path.join('Viaje', 'Dia1', 'b (2).jpg'), path.join('Viaje', 'a (2).jpg')].sort(), 'lo repetido recibe "(2)" en el nombre del ARCHIVO y no sobrescribe nada');
  assert.equal((await fs.readdir(path.join(getInputDir(), 'Viaje'))).filter((n) => n.endsWith('.jpg')).length, 2, 'a.jpg y a (2).jpg');

  await fs.rm(srcDir, { recursive: true, force: true });
});

test('findUnprocessedFiles distingue lo ya procesado de lo pendiente', async () => {
  const { importPaths } = require('../src/main/importer');
  const { listBatches, findUnprocessedFiles, getOutputPathFor } = require('../src/main/file-manager');

  const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-src2-'));
  await fs.mkdir(path.join(srcDir, 'LotePrueba'), { recursive: true });
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#0000ff' } })
    .jpeg().toFile(path.join(srcDir, 'LotePrueba', 'x.jpg'));
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ffff00' } })
    .jpeg().toFile(path.join(srcDir, 'LotePrueba', 'y.jpg'));

  const { importedFiles } = await importPaths([path.join(srcDir, 'LotePrueba')]);
  const doneFile = importedFiles.find((f) => f.endsWith('x.jpg'));
  const outPath = getOutputPathFor(doneFile);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, 'contenido-ya-procesado');

  const batches = await listBatches();
  const relevantBatches = batches.filter((b) => b.files.some((f) => importedFiles.includes(f)));
  const pending = await findUnprocessedFiles(relevantBatches);
  const pendingNames = pending.map((p) => path.basename(p));

  assert.ok(!pendingNames.includes('x.jpg'), 'x.jpg ya tiene salida, no deberia estar pendiente');
  assert.ok(pendingNames.some((n) => n.startsWith('y')), 'y.jpg no tiene salida, debe estar pendiente');

  await fs.rm(srcDir, { recursive: true, force: true });
});

// --- Regresion: la app volvia a comprimir fotos ya terminadas en cada
// arranque, porque comparaba el nombre de salida caracter por caracter
// (extension incluida) contra un nombre que el compresor casi nunca
// respeta tal cual (normaliza mayusculas/minusculas y puede cambiar la
// extension a .webp). Ver comentario en findUnprocessedFiles.

test('findUnprocessedFiles NO reprocesa una foto ya hecha aunque cambie mayus/minus de la extension (.JPG vs .jpg)', async () => {
  const { importPaths } = require('../src/main/importer');
  const { listBatches, findUnprocessedFiles } = require('../src/main/file-manager');
  const { getOutputDir } = require('../src/main/paths');

  const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-src3-'));
  await fs.mkdir(path.join(srcDir, 'LoteCamara'), { recursive: true });
  // Nombre tipico de camara/celular: extension en mayuscula.
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#123456' } })
    .jpeg().toFile(path.join(srcDir, 'LoteCamara', 'IMG_0001.JPG'));

  const { importedFiles } = await importPaths([path.join(srcDir, 'LoteCamara')]);
  const inputFile = importedFiles[0];
  const relative = path.relative(require('../src/main/paths').getInputDir(), inputFile);

  // Simula lo que realmente escribe raster-optimizer.js: mismo nombre base,
  // pero la extension normalizada en minuscula (esto es lo que antes rompia
  // la deteccion).
  const realOutputPath = path.join(getOutputDir(), path.dirname(relative), 'IMG_0001.jpg');
  await fs.mkdir(path.dirname(realOutputPath), { recursive: true });
  await fs.writeFile(realOutputPath, 'ya-comprimida');

  const batches = await listBatches();
  const relevantBatches = batches.filter((b) => b.files.includes(inputFile));
  const pending = await findUnprocessedFiles(relevantBatches);

  assert.ok(!pending.includes(inputFile), 'no debe reprocesar IMG_0001.JPG solo porque la salida quedo en minuscula');

  await fs.rm(srcDir, { recursive: true, force: true });
});

test('findUnprocessedFiles NO reprocesa una foto convertida a WebP (extension distinta a la original)', async () => {
  const { importPaths } = require('../src/main/importer');
  const { listBatches, findUnprocessedFiles } = require('../src/main/file-manager');
  const { getOutputDir, getInputDir } = require('../src/main/paths');

  const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-src4-'));
  await fs.mkdir(path.join(srcDir, 'LoteWebp'), { recursive: true });
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#654321' } })
    .jpeg().toFile(path.join(srcDir, 'LoteWebp', 'foto.jpg'));

  const { importedFiles } = await importPaths([path.join(srcDir, 'LoteWebp')]);
  const inputFile = importedFiles[0];
  const relative = path.relative(getInputDir(), inputFile);

  // Simula la salida real cuando "Convertir a WebP" esta activo: mismo
  // nombre base, extension .webp en vez de .jpg.
  const realOutputPath = path.join(getOutputDir(), path.dirname(relative), 'foto.webp');
  await fs.mkdir(path.dirname(realOutputPath), { recursive: true });
  await fs.writeFile(realOutputPath, 'ya-comprimida-webp');

  const batches = await listBatches();
  const relevantBatches = batches.filter((b) => b.files.includes(inputFile));
  const pending = await findUnprocessedFiles(relevantBatches);

  assert.ok(!pending.includes(inputFile), 'no debe reprocesar foto.jpg si ya existe foto.webp (conversion aplicada)');

  await fs.rm(srcDir, { recursive: true, force: true });
});

// --- Regresion / robustez: si output/ no refleja lo ya hecho a tiempo
// (por ejemplo, sincronizacion en la nube con retraso -- OneDrive/iCloud
// redirigiendo Documentos), el manifiesto interno (fuera de Documentos)
// sirve de respaldo para no reprocesar de todas formas.

test('findUnprocessedFiles confia en el manifiesto interno aunque output/ este vacio (simula retraso de OneDrive/iCloud)', async () => {
  const { importPaths } = require('../src/main/importer');
  const { listBatches, findUnprocessedFiles } = require('../src/main/file-manager');
  const manifestStore = require('../src/main/manifest-store');

  const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-src5-'));
  await fs.mkdir(path.join(srcDir, 'LoteNube'), { recursive: true });
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#abcdef' } })
    .jpeg().toFile(path.join(srcDir, 'LoteNube', 'recuerdo.jpg'));

  const { importedFiles } = await importPaths([path.join(srcDir, 'LoteNube')]);
  const inputFile = importedFiles[0];

  // A proposito NO se crea ningun archivo en output/: simula que la nube
  // todavia no bajo/mostro el resultado localmente, aunque la app si lo
  // proceso (por eso se marca en el manifiesto, como haria queue-manager.js
  // de verdad al terminar un trabajo).
  manifestStore.markDone(inputFile);

  const batches = await listBatches();
  const relevantBatches = batches.filter((b) => b.files.includes(inputFile));
  const pending = await findUnprocessedFiles(relevantBatches);

  assert.ok(!pending.includes(inputFile), 'el manifiesto debe evitar el reproceso aunque output/ este vacio');

  await fs.rm(srcDir, { recursive: true, force: true });
});

test('cleanupOrphanedTempFiles borra temporales viejos pero respeta los recientes', async () => {
  const { cleanupOrphanedTempFiles } = require('../src/main/file-manager');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-tmp-'));
  const oldTmp = path.join(dir, 'foto.jpg.tmp-aaaaaaaaaaaa');
  const freshTmp = path.join(dir, 'foto2.jpg.tmp-bbbbbbbbbbbb');
  await fs.writeFile(oldTmp, 'x');
  await fs.writeFile(freshTmp, 'x');

  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
  await fs.utimes(oldTmp, twoMinutesAgo, twoMinutesAgo);

  await cleanupOrphanedTempFiles(dir);

  const remaining = await fs.readdir(dir);
  assert.ok(!remaining.includes('foto.jpg.tmp-aaaaaaaaaaaa'), 'el temporal viejo debe borrarse');
  assert.ok(remaining.includes('foto2.jpg.tmp-bbbbbbbbbbbb'), 'el temporal reciente NO debe borrarse');

  await fs.rm(dir, { recursive: true, force: true });
});

test('hasOutputFor: solo es verdadero si el resultado existe en output/ (con el nombre que pudo darle el compresor)', async () => {
  const { hasOutputFor, getOutputPathFor } = require('../src/main/file-manager');
  const { getInputDir } = require('../src/main/paths');
  const input = path.join(getInputDir(), 'LoteHas', 'Foto.JPG');
  assert.equal(await hasOutputFor(input), false, 'sin salida todavia');
  const out = getOutputPathFor(input);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out.replace(/\.JPG$/, '.jpg'), 'x'); // el compresor normaliza la extension
  assert.equal(await hasOutputFor(input), true);
  await fs.rm(path.dirname(out), { recursive: true, force: true });
  assert.equal(await hasOutputFor(input), false, 'si se borra la salida, deja de contar');
});
