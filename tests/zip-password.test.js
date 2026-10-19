'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.COMPACTA_TEST_BASE_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'compacta-zippw-base-'));

const sharp = require('sharp');
const { extractZip } = require('../src/main/zip-extractor');
const { createContext } = require('../src/main/import-context');
const { importPaths } = require('../src/main/importer');
const { saveSettings } = require('../src/main/settings-store');
const { makeEncryptedZip, ENCRYPTED_ZIP_AVAILABLE } = require('./helpers/make-encrypted-zip');

const skip = !ENCRYPTED_ZIP_AVAILABLE && 'faltan `zip` o `pyzipper` para fabricar ZIP cifrados';
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'compacta-zippw-'));
const KINDS = ['zipcrypto', 'aes128', 'aes192', 'aes256'];
const PASSWORD = 'contraseña ñ 123 '; // con tilde, eñe y un espacio al final: se respeta tal cual

async function photo() {
  return sharp({ create: { width: 64, height: 48, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 50 } } }).jpeg({ quality: 90 }).toBuffer();
}

async function extract(zipPath, password) {
  const dest = await tmp();
  const ctx = createContext();
  ctx.password = password === undefined ? null : password;
  const files = await extractZip(zipPath, dest, ctx);
  return { dest, ctx, files };
}

for (const kind of KINDS) {
  for (const store of [false, true]) {
    test(`${kind}${store ? ' (sin comprimir)' : ''}: con la contraseña correcta se extrae igual que el original (byte a byte)`, { skip }, async (t) => {
      const dir = await tmp();
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      const original = await photo();
      const zipPath = path.join(dir, 'a.zip');
      assert.ok(makeEncryptedZip(zipPath, [{ name: 'foto.jpg', data: original }], { kind, password: PASSWORD, store }));
      const { dest, ctx, files } = await extract(zipPath, PASSWORD);
      t.after(() => fs.rm(dest, { recursive: true, force: true }));
      assert.deepEqual(ctx.failedArchives, []);
      assert.equal(files.length, 1);
      assert.deepEqual(await fs.readFile(files[0]), original);
    });
  }

  test(`${kind}: un archivo GRANDE (varios MB, muchos trozos) se descifra sin perder ni cambiar un solo byte`, { skip }, async (t) => {
    const dir = await tmp();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const big = Buffer.concat([await photo(), crypto.randomBytes(3 * 1024 * 1024 + 123)]); // un JPEG con cola: sigue siendo .jpg
    const zipPath = path.join(dir, 'grande.zip');
    assert.ok(makeEncryptedZip(zipPath, [{ name: 'grande.jpg', data: big }], { kind, password: 'clave', store: true }));
    const { dest, ctx, files } = await extract(zipPath, 'clave');
    t.after(() => fs.rm(dest, { recursive: true, force: true }));
    assert.deepEqual(ctx.failedArchives, []);
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(files[0])).digest('hex'), crypto.createHash('sha256').update(big).digest('hex'));
  });

  test(`${kind}: con una contraseña EQUIVOCADA no sale nada y se pide de nuevo (nunca un archivo basura)`, { skip }, async (t) => {
    const dir = await tmp();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const zipPath = path.join(dir, 'a.zip');
    assert.ok(makeEncryptedZip(zipPath, [{ name: 'foto.jpg', data: await photo() }], { kind, password: 'buena' }));
    for (const wrong of ['mala', 'buen', 'buena ', 'BUENA', 'x']) {
      const { dest, ctx, files } = await extract(zipPath, wrong);
      assert.equal(files.length, 0, `«${wrong}» no debe extraer nada`);
      assert.deepEqual(await fs.readdir(dest), [], 'ni archivos a medias ni temporales');
      assert.equal(ctx.failedArchives.length, 1);
      assert.equal(ctx.failedArchives[0].needsPassword, true);
      assert.equal(ctx.failedArchives[0].wrongPassword, true);
      assert.equal(ctx.failedArchives[0].archivePath, zipPath, 'lleva la ruta para reintentar');
      assert.match(ctx.failedArchives[0].reason, /contraseña/);
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  test(`${kind}: sin contraseña avisa de que hace falta (y ofrece reintentar), sin tratarla como dañada`, { skip }, async (t) => {
    const dir = await tmp();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const zipPath = path.join(dir, 'a.zip');
    assert.ok(makeEncryptedZip(zipPath, [{ name: 'foto.jpg', data: await photo() }], { kind }));
    const { dest, ctx, files } = await extract(zipPath);
    t.after(() => fs.rm(dest, { recursive: true, force: true }));
    assert.equal(files.length, 0);
    assert.equal(ctx.failedArchives[0].needsPassword, true);
    assert.equal(ctx.failedArchives[0].wrongPassword, false);
    assert.match(ctx.failedArchives[0].reason, /contraseña/);
  });
}

test('un archivo cifrado que NO se iba a importar (un leeme.txt) no pide contraseña: las fotos se importan igual', { skip }, async (t) => {
  const dir = await tmp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, 'a.zip');
  const original = await photo();
  assert.ok(makeEncryptedZip(zipPath, [{ name: 'leeme.txt', data: Buffer.from('hola') }, { name: 'foto.jpg', data: original }], { kind: 'aes256', password: 'x' }));
  // todas las entradas van cifradas, la foto SÍ hace falta; con contraseña entra, y el .txt nunca estorba
  const { dest, ctx, files } = await extract(zipPath, 'x');
  t.after(() => fs.rm(dest, { recursive: true, force: true }));
  assert.deepEqual(ctx.failedArchives, []);
  assert.equal(files.length, 1);
  assert.deepEqual(await fs.readFile(files[0]), original);
  const none = await extract(zipPath);
  assert.equal(none.ctx.failedArchives[0].needsPassword, true, 'sin contraseña, la foto sí la pide');
  await fs.rm(none.dest, { recursive: true, force: true });
});

test('AES: un archivo ALTERADO se detecta (autenticación) y se avisa como dañado, no como contraseña equivocada', { skip }, async (t) => {
  const dir = await tmp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, 'a.zip');
  const data = Buffer.concat([await photo(), crypto.randomBytes(50000)]);
  assert.ok(makeEncryptedZip(zipPath, [{ name: 'foto.jpg', data }], { kind: 'aes256', password: 'clave', store: true }));
  const bytes = await fs.readFile(zipPath);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff; // un bit cambiado en medio de los datos
  await fs.writeFile(zipPath, bytes);
  const { dest, ctx, files } = await extract(zipPath, 'clave');
  t.after(() => fs.rm(dest, { recursive: true, force: true }));
  assert.equal(files.length, 0);
  assert.deepEqual(await fs.readdir(dest), []);
  assert.equal(ctx.failedArchives.length, 1);
  assert.ok(!ctx.failedArchives[0].needsPassword, 'no vuelve a pedir la contraseña por un archivo dañado');
});

test('de extremo a extremo: importPaths con la contraseña importa la foto; sin ella la deja pendiente con su ruta', { skip }, async (t) => {
  saveSettings({ skipDuplicates: true });
  const dir = await tmp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, 'Reservadas.zip');
  assert.ok(makeEncryptedZip(zipPath, [{ name: 'a.jpg', data: await photo() }], { kind: 'zipcrypto', password: 'abc' }));

  const locked = await importPaths([zipPath]);
  assert.equal(locked.importedFiles.length, 0);
  assert.equal(locked.failedArchives[0].needsPassword, true);

  const opened = await importPaths([locked.failedArchives[0].archivePath], { password: 'abc' });
  assert.equal(opened.importedFiles.length, 1);
  assert.deepEqual(opened.failedArchives, []);
});

test('un ZIP sin cifrar sigue igual (y la contraseña de sobra no le afecta)', async (t) => {
  const { makeZip } = require('./helpers/make-zip');
  const dir = await tmp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, 'normal.zip');
  const original = await photo();
  await fs.writeFile(zipPath, makeZip([{ name: 'a.jpg', data: original }]));
  const { dest, ctx, files } = await extract(zipPath, 'no hace falta');
  t.after(() => fs.rm(dest, { recursive: true, force: true }));
  assert.deepEqual(ctx.failedArchives, []);
  assert.deepEqual(await fs.readFile(files[0]), original);
});

test('ZipCrypto: 1 de cada ~128 contraseñas malas pasa la comprobación de un byte; NINGUNA deja basura ni se informa mal', { skip }, async (t) => {
  const dir = await tmp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, 'a.zip');
  assert.ok(makeEncryptedZip(zipPath, [{ name: 'foto.jpg', data: await photo() }], { kind: 'zipcrypto', password: 'la-buena' }));
  for (let i = 0; i < 700; i += 1) {
    const { dest, ctx, files } = await extract(zipPath, `mala-${crypto.randomBytes(4).toString('hex')}`);
    assert.equal(files.length, 0);
    assert.deepEqual(await fs.readdir(dest), [], 'ni a medias ni temporales');
    assert.ok(ctx.failedArchives[0] && ctx.failedArchives[0].needsPassword && ctx.failedArchives[0].wrongPassword, `intento ${i}: ${JSON.stringify(ctx.failedArchives)}`);
    await fs.rm(dest, { recursive: true, force: true });
  }
});
