'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { makeZip } = require('./helpers/make-zip');
const { extractZip } = require('../src/main/zip-extractor');
const { safeSegments } = require('../src/main/file-names');
const { createContext } = require('../src/main/import-context');

async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `compacta-${prefix}-`));
}

async function jpeg(color = '#ff0000') {
  return sharp({ create: { width: 24, height: 24, channels: 3, background: color } }).jpeg().toBuffer();
}

async function listAll(dir) {
  const out = [];
  async function walk(d) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  }
  await walk(dir);
  return out.sort();
}

test('extrae solo imagenes, conserva subcarpetas e ignora la basura de macOS/Windows', async () => {
  const work = await tmpDir('zip-basic');
  const img = await jpeg();
  const zipPath = path.join(work, 'fotos.zip');
  await fs.writeFile(zipPath, makeZip([
    { name: 'Viaje/', data: '' },
    { name: 'Viaje/a.jpg', data: img },
    { name: 'Viaje/Dia1/b.JPG', data: img, deflate: true },
    { name: '__MACOSX/Viaje/._a.jpg', data: 'basura' },
    { name: 'Viaje/.DS_Store', data: 'basura' },
    { name: 'Viaje/Thumbs.db', data: 'basura' },
    { name: 'Viaje/notas.txt', data: 'hola' },
    { name: 'Viaje/programa.exe', data: 'MZ' }
  ]));
  const dest = path.join(work, 'salida');
  const ctx = createContext();

  const files = await extractZip(zipPath, dest, ctx);

  assert.deepEqual(await listAll(dest), ['Viaje/Dia1/b.JPG', 'Viaje/a.jpg']);
  assert.equal(files.length, 2);
  assert.equal(ctx.failedArchives.length, 0);
  assert.equal(ctx.skippedCount, 2, 'notas.txt y programa.exe se cuentan; la basura del sistema NO');
  assert.deepEqual([...ctx.skippedExtensions].sort(), ['.exe', '.txt']);
  // Lo extraido es una imagen real y completa (la comprimida con deflate tambien).
  assert.equal((await sharp(path.join(dest, 'Viaje/Dia1/b.JPG')).metadata()).width, 24);
  await fs.rm(work, { recursive: true, force: true });
});

test('zip-slip: una entrada con ../ no puede escribir fuera de la carpeta destino', async () => {
  const work = await tmpDir('zip-slip');
  const img = await jpeg();
  const zipPath = path.join(work, 'malo.zip');
  await fs.writeFile(zipPath, makeZip([
    { name: 'ok.jpg', data: img },
    { name: '../../evil.jpg', data: img }
  ]));
  const dest = path.join(work, 'a', 'b', 'salida');
  const ctx = createContext();

  await extractZip(zipPath, dest, ctx);

  await assert.rejects(fs.access(path.join(work, 'evil.jpg')), 'no debe existir fuera del destino');
  await assert.rejects(fs.access(path.join(work, 'a', 'evil.jpg')));
  assert.equal(ctx.failedArchives.length, 1);
  assert.match(ctx.failedArchives[0].reason, /rutas no seguras/);
  await fs.rm(work, { recursive: true, force: true });
});

test('safeSegments rechaza .. y letras de unidad, limpia caracteres de Windows y descarta basura', () => {
  assert.throws(() => safeSegments('a/../../x.jpg'), /insegura/);
  assert.throws(() => safeSegments('C:/Windows/x.jpg'), /insegura/);
  assert.deepEqual(safeSegments('/abs/x.jpg'), ['abs', 'x.jpg'], 'la barra inicial no saca del destino: se ignora');
  assert.deepEqual(safeSegments('dir/fo:to?.jpg'), ['dir', 'fo_to_.jpg']);
  assert.equal(safeSegments('__MACOSX/x/._y.jpg'), null);
  assert.equal(safeSegments('a/.hidden.jpg'), null);
});

test('un ZIP dentro de otro ZIP tambien se descomprime', async () => {
  const work = await tmpDir('zip-nested');
  const img = await jpeg();
  const inner = makeZip([{ name: 'interna.jpg', data: img }]);
  const zipPath = path.join(work, 'externa.zip');
  await fs.writeFile(zipPath, makeZip([
    { name: 'raiz.jpg', data: img },
    { name: 'paquete.zip', data: inner }
  ]));
  const dest = path.join(work, 'salida');
  const ctx = createContext();

  await extractZip(zipPath, dest, ctx);

  assert.deepEqual(await listAll(dest), ['paquete/interna.jpg', 'raiz.jpg']);
  assert.equal(ctx.archiveCount, 2);
  assert.equal(ctx.failedArchives.length, 0);
  await fs.rm(work, { recursive: true, force: true });
});

test('ZIPs anidados mas alla del limite de profundidad no se siguen (anti-bomba recursiva)', async () => {
  const work = await tmpDir('zip-depth');
  const img = await jpeg();
  let zip = makeZip([{ name: 'fondo.jpg', data: img }]);
  for (let i = 0; i < 5; i += 1) zip = makeZip([{ name: `nivel${i}.zip`, data: zip }]);
  const zipPath = path.join(work, 'matrioska.zip');
  await fs.writeFile(zipPath, zip);
  const ctx = createContext();

  const files = await extractZip(zipPath, path.join(work, 'salida'), ctx);

  assert.equal(files.length, 0, 'la imagen del fondo queda mas alla del limite');
  assert.ok(ctx.skippedCount >= 1, 'el ZIP no seguido se cuenta como omitido');
  await fs.rm(work, { recursive: true, force: true });
});

test('un archivo corrupto o que no es ZIP no lanza: se anota con el motivo', async () => {
  const work = await tmpDir('zip-corrupt');
  const zipPath = path.join(work, 'roto.zip');
  await fs.writeFile(zipPath, Buffer.from('esto no es un zip de verdad, solo texto suelto para probar'));
  const ctx = createContext();

  const files = await extractZip(zipPath, path.join(work, 'salida'), ctx);

  assert.deepEqual(files, []);
  assert.equal(ctx.failedArchives.length, 1);
  assert.equal(ctx.failedArchives[0].name, 'roto.zip');
  assert.match(ctx.failedArchives[0].reason, /dañado|no es un ZIP/);
  await fs.rm(work, { recursive: true, force: true });
});

test('un ZIP con contrasena se avisa como tal', async () => {
  const work = await tmpDir('zip-enc');
  const zipPath = path.join(work, 'secreto.zip');
  await fs.writeFile(zipPath, makeZip([{ name: 'a.jpg', data: await jpeg(), encrypted: true, deflate: true }]));
  const ctx = createContext();

  await extractZip(zipPath, path.join(work, 'salida'), ctx);

  assert.equal(ctx.failedArchives.length, 1);
  assert.match(ctx.failedArchives[0].reason, /contraseña/);
  await fs.rm(work, { recursive: true, force: true });
});

test('limite de tamano total descomprimido (anti zip-bomb): se corta y se avisa, sin dejar restos', async () => {
  const work = await tmpDir('zip-bomb');
  const big = Buffer.alloc(200000, 7);
  const zipPath = path.join(work, 'bomba.zip');
  await fs.writeFile(zipPath, makeZip([
    { name: '1.png', data: big, deflate: true },
    { name: '2.png', data: big, deflate: true },
    { name: '3.png', data: big, deflate: true }
  ]));
  const ctx = createContext({ maxTotalBytes: 450000 });

  await extractZip(zipPath, path.join(work, 'salida'), ctx);

  assert.equal(ctx.failedArchives.length, 1);
  assert.match(ctx.failedArchives[0].reason, /demasiado grande/);
  const left = await listAll(path.join(work, 'salida'));
  assert.ok(left.every((n) => !n.includes('.tmp-')), 'no deben quedar temporales a medias');
  assert.equal(left.length, 2, 'lo que cabia dentro del limite se conserva');
  await fs.rm(work, { recursive: true, force: true });
});

test('dos entradas con el mismo nombre no se pisan', async () => {
  const work = await tmpDir('zip-dup');
  const a = await jpeg('#ff0000');
  const b = await jpeg('#0000ff');
  const zipPath = path.join(work, 'dup.zip');
  await fs.writeFile(zipPath, makeZip([{ name: 'x.jpg', data: a }, { name: 'x.jpg', data: b }]));
  const dest = path.join(work, 'salida');

  await extractZip(zipPath, dest, createContext());

  assert.deepEqual(await listAll(dest), ['x (2).jpg', 'x.jpg']);
  await fs.rm(work, { recursive: true, force: true });
});
