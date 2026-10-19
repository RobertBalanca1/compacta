'use strict';

const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.COMPACTA_TEST_BASE_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'compacta-dup-base-'));

const sharp = require('sharp');
const { importPaths } = require('../src/main/importer');
const { saveSettings } = require('../src/main/settings-store');
const { getInputDir } = require('../src/main/paths');
const { createDuplicateDetector } = require('../src/main/duplicates');
const { makeVideo } = require('./helpers/make-video');
const { makeZip } = require('./helpers/make-zip');

const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), `compacta-dup-${p}-`));
// Colores bien separados: dos JPEG de un color casi igual (r=20 y r=21) salen con
// exactamente los mismos bytes, y entonces SI son duplicados de verdad.
const photo = (seed) => sharp({ create: { width: 120, height: 80, channels: 3, background: { r: (seed * 37) % 256, g: (seed * 91) % 256, b: (seed * 53) % 256 } } }).jpeg({ quality: 95 }).toBuffer();
const listInput = async () => (await fs.readdir(getInputDir()).catch(() => [])).filter((n) => !n.startsWith('.'));

test.beforeEach(() => saveSettings({ skipDuplicates: true }));

test('importar DOS VECES la misma foto: la segunda se omite, se cuenta y no deja ni copia ni carpeta vacia', async () => {
  const src = await tmp('twice');
  await fs.mkdir(path.join(src, 'Viaje'));
  await fs.writeFile(path.join(src, 'Viaje', 'a.jpg'), await photo(10));
  const before = await listInput();

  const first = await importPaths([path.join(src, 'Viaje')]);
  assert.equal(first.importedFiles.length, 1);
  assert.equal(first.duplicateCount, 0);
  const afterFirst = await listInput();

  const second = await importPaths([path.join(src, 'Viaje')]);

  assert.equal(second.importedFiles.length, 0, 'nada nuevo que comprimir');
  assert.equal(second.duplicateCount, 1);
  assert.deepEqual(await listInput(), afterFirst, 'no queda "Viaje (2)" vacia en input/');
  assert.ok(afterFirst.length > before.length);
  await fs.rm(src, { recursive: true, force: true });
});

test('dentro de una misma importacion: dos copias con distinto nombre -> entra una', async () => {
  const src = await tmp('same');
  const bytes = await photo(20);
  await fs.writeFile(path.join(src, 'original.jpg'), bytes);
  await fs.writeFile(path.join(src, 'copia de original.jpg'), bytes);
  await fs.writeFile(path.join(src, 'otra.jpg'), await photo(21));

  const result = await importPaths([src]);

  assert.equal(result.importedFiles.length, 2, 'original (o copia) + otra');
  assert.equal(result.duplicateCount, 1);
  await fs.rm(src, { recursive: true, force: true });
});

test('NO se confunden archivos distintos con el mismo tamano', async () => {
  const src = await tmp('size');
  const a = Buffer.alloc(5000, 1);
  const b = Buffer.alloc(5000, 1);
  b[4999] = 2; // mismo tamano, distinto en el ultimo byte
  const c = Buffer.alloc(5000, 1);
  c[0] = 9; // mismo tamano, distinto en el primero
  await fs.writeFile(path.join(src, 'a.jpg'), a);
  await fs.writeFile(path.join(src, 'b.jpg'), b);
  await fs.writeFile(path.join(src, 'c.jpg'), c);

  const result = await importPaths([src]);

  assert.equal(result.importedFiles.length, 3);
  assert.equal(result.duplicateCount, 0);
  await fs.rm(src, { recursive: true, force: true });
});

test('archivos grandes: la huella parcial separa los distintos (cambio en el MEDIO, solo lo ve el hash completo)', async () => {
  const dir = await tmp('big');
  const size = 5 * 1024 * 1024;
  const base = crypto.randomBytes(size);
  const sameButMiddle = Buffer.from(base);
  sameButMiddle[size / 2] ^= 0xff; // el principio y el final son iguales: la huella parcial NO lo distingue
  await fs.mkdir(getInputDir(), { recursive: true });
  await fs.mkdir(path.join(getInputDir(), 'grandes'), { recursive: true });
  const existing = path.join(getInputDir(), 'grandes', 'existente.jpg');
  await fs.writeFile(existing, base);

  const detector = await createDuplicateDetector(getInputDir());
  await fs.writeFile(path.join(dir, 'identico.jpg'), base);
  await fs.writeFile(path.join(dir, 'casi.jpg'), sameButMiddle);
  const { unique, duplicates } = await detector.filter([path.join(dir, 'identico.jpg'), path.join(dir, 'casi.jpg')]);

  assert.deepEqual(duplicates.map((d) => path.basename(d.filePath)), ['identico.jpg']);
  assert.deepEqual(unique.map((f) => path.basename(f)), ['casi.jpg'], 'el que difiere en el medio NO es duplicado');
  await fs.rm(existing, { force: true });
  await fs.rm(dir, { recursive: true, force: true });
});

test('con "Omitir duplicados" desactivado, todo entra otra vez (volver a comprimir con otros ajustes)', async () => {
  const src = await tmp('off');
  await fs.writeFile(path.join(src, 'x.jpg'), await photo(30));
  await importPaths([src]);
  saveSettings({ skipDuplicates: false });

  const again = await importPaths([src]);

  assert.equal(again.importedFiles.length, 1);
  assert.equal(again.duplicateCount, 0);
  await fs.rm(src, { recursive: true, force: true });
});

test('un video duplicado se omite CON sus subtitulos, y la carpeta vacia desaparece', async () => {
  const src = await tmp('video');
  await fs.mkdir(path.join(src, 'P'));
  makeVideo(path.join(src, 'P', 'Peli.mp4'), { seconds: 1 });
  await fs.writeFile(path.join(src, 'P', 'Peli.srt'), '1\n00:00:00,000 --> 00:00:01,000\nHola\n');
  await importPaths([path.join(src, 'P')]);
  const afterFirst = await listInput();

  const second = await importPaths([path.join(src, 'P')]);

  assert.equal(second.importedFiles.length, 0);
  assert.equal(second.duplicateCount, 1);
  assert.deepEqual(await listInput(), afterFirst, 'sin carpeta "P (2)" ni subtitulos huerfanos');
  await fs.rm(src, { recursive: true, force: true });
});

test('dentro de un ZIP: dos fotos identicas -> entra una; y un ZIP repetido no mete nada', async () => {
  const src = await tmp('zip');
  const bytes = await photo(40);
  const zipPath = path.join(src, 'Pack.zip');
  await fs.writeFile(zipPath, makeZip([{ name: 'a.jpg', data: bytes }, { name: 'sub/copia.jpg', data: bytes }, { name: 'b.jpg', data: await photo(41) }]));

  const first = await importPaths([zipPath]);
  assert.equal(first.importedFiles.length, 2);
  assert.equal(first.duplicateCount, 1);

  const second = await importPaths([zipPath]);
  assert.equal(second.importedFiles.length, 0);
  assert.equal(second.duplicateCount, 3, 'las 3 fotos que trae el ZIP ya estan importadas (a y copia son la misma foto, y b)');
  await fs.rm(src, { recursive: true, force: true });
});

test('los archivos vacios nunca cuentan como duplicados entre si', async () => {
  const src = await tmp('empty');
  await fs.writeFile(path.join(src, 'v1.jpg'), '');
  await fs.writeFile(path.join(src, 'v2.jpg'), '');
  const result = await importPaths([src]);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.importedFiles.length, 2, 'ya fallaran al procesarse, con su propio aviso');
  await fs.rm(src, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// 1.0.10: "omitir duplicados omitia todo" y fotos parecidas pero distintas
// ---------------------------------------------------------------------------

/** Una "foto" con una cara aproximada: un ovalo y una boca que puede estar abierta o cerrada. */
const face = (mouthOpen, quality = 92) => {
  const w = 1200;
  const h = 800;
  const mouth = mouthOpen
    ? '<ellipse cx="600" cy="520" rx="70" ry="55" fill="#400"/>'
    : '<rect x="530" y="515" width="140" height="10" rx="5" fill="#400"/>';
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#7a8fa8"/><ellipse cx="600" cy="400" rx="260" ry="320" fill="#e0b894"/><circle cx="510" cy="360" r="22" fill="#222"/><circle cx="690" cy="360" r="22" fill="#222"/>${mouth}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality }).toBuffer();
};

test('FOTOS PARECIDAS NO SON DUPLICADAS: la misma escena con la boca abierta y con la boca cerrada entran las dos', async () => {
  const src = await tmp('face');
  await fs.writeFile(path.join(src, 'boca-cerrada.jpg'), await face(false));
  await fs.writeFile(path.join(src, 'boca-abierta.jpg'), await face(true));
  await fs.writeFile(path.join(src, 'boca-cerrada-otra-calidad.jpg'), await face(false, 70)); // misma foto, guardada con otra calidad

  const result = await importPaths([src]);

  assert.equal(result.importedFiles.length, 3, 'las tres son archivos distintos');
  assert.equal(result.duplicateCount, 0);
  await fs.rm(src, { recursive: true, force: true });
});

test('rafaga: 12 fotos casi iguales (cambia un detalle pequeno) -> entran las 12', async () => {
  const src = await tmp('burst');
  for (let i = 0; i < 12; i += 1) {
    const svg = `<svg width="1000" height="700" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#8aa"/><circle cx="${300 + i * 3}" cy="300" r="90" fill="#c44"/></svg>`;
    await fs.writeFile(path.join(src, `rafaga_${i}.jpg`), await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer());
  }
  const result = await importPaths([src]);
  assert.equal(result.importedFiles.length, 12);
  assert.equal(result.duplicateCount, 0);
  await fs.rm(src, { recursive: true, force: true });
});

test('algo importado hace tiempo cuyo resultado YA NO EXISTE no cuenta como duplicado (antes se omitia todo)', async () => {
  const src = await tmp('stale');
  await fs.writeFile(path.join(src, 'vieja.jpg'), await photo(77));
  // Primera vez: nadie la procesa y no hay resultado (como una prueba de hace semanas cuya salida se borro).
  const first = await importPaths([src], { isLive: async () => false });
  assert.equal(first.importedFiles.length, 1);

  const again = await importPaths([src], { isLive: async () => false });

  assert.equal(again.importedFiles.length, 1, 'se vuelve a importar y procesar');
  assert.equal(again.duplicateCount, 0);
  await fs.rm(src, { recursive: true, force: true });
});

test('algo cuyo resultado SIGUE existiendo si se omite, y se cuenta aparte de los repetidos de la propia importacion', async () => {
  const src = await tmp('alive');
  const bytes = await photo(88);
  await fs.writeFile(path.join(src, 'uno.jpg'), bytes);
  await importPaths([src], { isLive: async () => true });

  const dst = await tmp('alive2');
  await fs.writeFile(path.join(dst, 'uno-otra-vez.jpg'), bytes); // igual a lo de antes
  await fs.writeFile(path.join(dst, 'nuevo.jpg'), await photo(89));
  await fs.writeFile(path.join(dst, 'nuevo-copia.jpg'), await photo(89)); // repetido dentro de lo que se suelta
  const result = await importPaths([dst], { isLive: async () => true });

  assert.equal(result.importedFiles.length, 1, 'solo "nuevo"');
  assert.equal(result.duplicateBefore, 1);
  assert.equal(result.duplicateInDrop, 1);
  assert.equal(result.duplicateCount, 2);
  await fs.rm(src, { recursive: true, force: true });
  await fs.rm(dst, { recursive: true, force: true });
});

test('el resultado existe pero en la cola dio ERROR -> no cuenta como hecho (se puede reintentar soltandolo otra vez)', async () => {
  const src = await tmp('err');
  await fs.writeFile(path.join(src, 'rota.jpg'), await photo(99));
  await importPaths([src], { isLive: async () => true });
  const again = await importPaths([src], { isLive: async () => false });
  assert.equal(again.importedFiles.length, 1);
  await fs.rm(src, { recursive: true, force: true });
});
