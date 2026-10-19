'use strict';

const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.COMPACTA_TEST_BASE_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'compacta-stream-base-'));

const sharp = require('sharp');
const { importPaths } = require('../src/main/importer');
const { saveSettings } = require('../src/main/settings-store');
const { getInputDir } = require('../src/main/paths');
const { createDuplicateDetector, sharedIndex, noteImported, resetSharedIndexes } = require('../src/main/duplicates');
const { optimizeImage } = require('../src/main/processor/raster-optimizer');

const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), `compacta-stream-${p}-`));
let jpegBase;
const uniquePhoto = async (n) => Buffer.concat([jpegBase || (jpegBase = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 90, g: 140, b: 200 } } }).jpeg().toBuffer()), crypto.randomBytes(40 + n)]);

test.beforeEach(() => {
  saveSettings({ skipDuplicates: true });
  resetSharedIndexes();
});

test('una carpeta grande llega a la cola POR TANDAS (la primera corta), en orden y sin perder ni repetir nada', async () => {
  const src = await tmp('chunks');
  const names = [];
  for (let i = 0; i < 150; i += 1) {
    const name = `IMG_${String(i).padStart(4, '0')}.jpg`;
    names.push(name);
    await fs.writeFile(path.join(src, name), await uniquePhoto(i));
  }
  const batches = [];
  const result = await importPaths([src], { onFiles: (files) => { batches.push(files.map((f) => path.basename(f))); } });

  assert.ok(batches.length >= 3, `debía entregarse en varias tandas, fueron ${batches.length}`);
  assert.ok(batches[0].length <= 8, `la primera tanda es corta para empezar enseguida (fue de ${batches[0].length})`);
  const delivered = batches.flat();
  assert.deepEqual(delivered, names, 'todas, una vez cada una y en el orden original');
  assert.equal(result.importedFiles.length, 150);
  await fs.rm(src, { recursive: true, force: true });
});

test('foto.jpg y foto.png en una carpeta grande: aunque la cola empiece ANTES de terminar la copia, no se pisan', async () => {
  const src = await tmp('siblings');
  await sharp({ create: { width: 90, height: 60, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 40 } } }).jpeg({ quality: 98 }).toFile(path.join(src, 'foto.jpg'));
  await sharp({ create: { width: 90, height: 60, channels: 3, noise: { type: 'gaussian', mean: 100, sigma: 50 } } }).png().toFile(path.join(src, 'foto.png'));
  for (let i = 0; i < 120; i += 1) await fs.writeFile(path.join(src, `zz_${String(i).padStart(3, '0')}.jpg`), await uniquePhoto(i));

  const outDir = await tmp('siblings-out');
  const outputs = [];
  const pending = [];
  await importPaths([src], {
    // Se procesa nada más llegar cada tanda, como hace la cola: la copia de la carpeta aún no ha terminado.
    onFiles: (files) => {
      for (const file of files) {
        if (/foto\.(jpg|png)$/.test(file)) pending.push(optimizeImage(file, path.join(outDir, path.basename(file)), { quality: 80 }).then((r) => outputs.push(path.basename(r.output))));
      }
    }
  });
  await Promise.all(pending);
  assert.equal(new Set(outputs).size, 2, `las dos salidas deben ser distintas: ${outputs}`);
  assert.deepEqual(outputs.sort(), ['foto_jpg.jpg', 'foto_png.png']);
  await fs.rm(src, { recursive: true, force: true });
  await fs.rm(outDir, { recursive: true, force: true });
});

test('el índice compartido se construye UNA vez: las importaciones siguientes no recorren el historial', async () => {
  const input = getInputDir();
  await fs.mkdir(path.join(input, 'Historial'), { recursive: true });
  for (let i = 0; i < 30; i += 1) await fs.writeFile(path.join(input, 'Historial', `old_${i}.jpg`), await uniquePhoto(i));

  let listings = 0;
  const first = await sharedIndex(input, async () => { listings += 1; return fsSync.readdirSync(path.join(input, 'Historial')).map((n) => path.join(input, 'Historial', n)); });
  const again = await sharedIndex(input, async () => { listings += 1; return []; });
  assert.equal(listings, 1, 'solo se lista el historial la primera vez');
  assert.equal(first, again, 'es el mismo índice');
  let total = 0;
  for (const list of first.bySize.values()) total += list.length;
  assert.equal(total, 30);

  // y una importación nueva lo usa y lo amplía, sin volver a listar
  const src = await tmp('shared');
  await fs.writeFile(path.join(src, 'nueva.jpg'), await uniquePhoto(999));
  await importPaths([src]);
  let after = 0;
  for (const list of first.bySize.values()) after += list.length;
  assert.equal(after, 31, 'lo importado se apunta en el índice para la vez siguiente');
  await fs.rm(src, { recursive: true, force: true });
});

test('un duplicado de algo ya importado se detecta con el índice compartido (y se sigue omitiendo)', async () => {
  const src = await tmp('dup-shared');
  const bytes = await uniquePhoto(5);
  await fs.writeFile(path.join(src, 'a.jpg'), bytes);
  await importPaths([src]);
  const second = await importPaths([src]);
  assert.equal(second.duplicateCount, 1);
  assert.equal(second.importedFiles.length, 0);
  await fs.rm(src, { recursive: true, force: true });
});

test('si algo del índice desapareció del disco, no rompe: simplemente deja de contar', async () => {
  const dir = await tmp('stale');
  const input = path.join(dir, 'input');
  await fs.mkdir(input);
  const bytes = await uniquePhoto(7);
  const gone = path.join(input, 'borrado.jpg');
  const kept = path.join(input, 'queda.jpg');
  await fs.writeFile(gone, bytes);
  await fs.writeFile(kept, bytes);
  const index = await sharedIndex(input);
  await fs.rm(gone); // lo borra alguien (cancelar pendientes, vaciar la carpeta...)

  const incoming = path.join(input, 'nuevo.jpg');
  await fs.writeFile(incoming, bytes);
  const detector = await createDuplicateDetector(input, { isLive: async () => true, index });
  const { unique, duplicates } = await detector.filter([incoming]);
  assert.equal(unique.length, 0, 'sigue habiendo un duplicado real (queda.jpg)');
  assert.equal(duplicates.length, 1);
  // y el candidato desaparecido se retiró del índice
  const sizes = [...index.bySize.values()].flat();
  assert.ok(!sizes.includes(gone), 'el borrado ya no está en el índice');
  await fs.rm(dir, { recursive: true, force: true });
});

test('con la detección apagada, lo importado igualmente se apunta en el índice para cuando se vuelva a encender', async () => {
  const input = getInputDir();
  const index = await sharedIndex(input);
  saveSettings({ skipDuplicates: false });
  const src = await tmp('off');
  await fs.writeFile(path.join(src, 'x.jpg'), await uniquePhoto(11));
  const before = [...index.bySize.values()].flat().length;
  await importPaths([src]);
  assert.equal([...index.bySize.values()].flat().length, before + 1);
  await noteImported(input, []); // sin archivos: no hace nada ni falla
  await fs.rm(src, { recursive: true, force: true });
});

test('nombres previstos: con foto.png AÚN sin copiar, foto.jpg ya sabe que no puede llamarse igual que su salida', async () => {
  const { expectSiblings, unexpectSibling, releaseSiblings, chooseOutputPath } = require('../src/main/processor/output-files');
  const dir = await tmp('expect');
  const out = path.join(dir, 'out');
  await fs.mkdir(out);
  const jpg = path.join(dir, 'foto.jpg');
  await fs.writeFile(jpg, await uniquePhoto(1)); // foto.png todavía NO existe en disco

  assert.equal(path.basename(await chooseOutputPath(jpg, path.join(out, 'foto.jpg'))), 'foto.jpg', 'sin previsión, no hay hermano que conozca');

  expectSiblings(dir, ['foto.jpg', 'foto.png']);
  assert.equal(path.basename(await chooseOutputPath(jpg, path.join(out, 'foto.jpg'))), 'foto_jpg.jpg', 'con el hermano previsto, se diferencia ya');

  unexpectSibling(dir, 'foto.png'); // era un duplicado y se descartó: ya no va a llegar
  assert.equal(path.basename(await chooseOutputPath(jpg, path.join(out, 'foto.jpg'))), 'foto.jpg', 'descartado, vuelve el nombre normal');

  releaseSiblings(dir); // termina esa importación
  expectSiblings(dir, ['foto.jpg', 'foto.png']);
  releaseSiblings(dir); // terminó la copia: manda lo que hay en disco
  assert.equal(path.basename(await chooseOutputPath(jpg, path.join(out, 'foto.jpg'))), 'foto.jpg');
  await fs.rm(dir, { recursive: true, force: true });
});

test('dos importaciones copiando a la vez a la MISMA carpeta: los nombres previstos se suman y solo se sueltan al acabar las dos', async () => {
  const { expectSiblings, releaseSiblings, chooseOutputPath } = require('../src/main/processor/output-files');
  const dir = await tmp('refcount');
  const out = path.join(dir, 'out');
  await fs.mkdir(out);
  const jpg = path.join(dir, 'foto.jpg');
  await fs.writeFile(jpg, await uniquePhoto(2));
  const name = async () => path.basename(await chooseOutputPath(jpg, path.join(out, 'foto.jpg')));

  expectSiblings(dir, ['foto.jpg']);    // importación A
  assert.equal(await name(), 'foto.jpg');
  expectSiblings(dir, ['foto.png']);    // importación B, misma carpeta
  assert.equal(await name(), 'foto_jpg.jpg', 'los nombres de B también cuentan');
  releaseSiblings(dir);                 // termina A: B sigue copiando, no se suelta
  assert.equal(await name(), 'foto_jpg.jpg', 'mientras B copia, sigue valiendo lo previsto');
  releaseSiblings(dir);                 // termina B: manda el disco (solo hay foto.jpg)
  assert.equal(await name(), 'foto.jpg');
  await fs.rm(dir, { recursive: true, force: true });
});
