'use strict';

// "Que funcione con todo tipo de comprimido": archivos reales de cada formato
// (hechos con tar, 7z y rar de verdad) pasan por la importacion completa.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

process.env.COMPACTA_TEST_BASE_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'compacta-arch-base-'));

const sharp = require('sharp');
const { importPaths } = require('../src/main/importer');
const { getInputDir } = require('../src/main/paths');
const { findTarBinary } = require('../src/main/system-archive');
const { extractArchive } = require('../src/main/archive-extractor');
const { createContext } = require('../src/main/import-context');
const { ARCHIVE_EXTENSIONS, isArchiveFile, archiveStem } = require('../src/main/processor/formats');
const { makeZip } = require('./helpers/make-zip');
const { makeVideo } = require('./helpers/make-video');
const { TOOLS, makeArchive, makeHostileTar } = require('./helpers/make-archive');

const HAS_TAR = findTarBinary() !== null;
const rel = (p) => path.relative(getInputDir(), p).split(path.sep).join('/');

/** Carpeta con 1 foto, 1 video, un txt y una subcarpeta con otra foto. */
async function sampleFolder() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-arch-src-'));
  const photo = await sharp({ create: { width: 64, height: 48, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 40 } } }).jpeg().toBuffer();
  await fs.mkdir(path.join(dir, 'Sub'));
  await fs.writeFile(path.join(dir, 'foto.jpg'), photo);
  await fs.writeFile(path.join(dir, 'Sub', 'otra.png'), await sharp(photo).png().toBuffer());
  makeVideo(path.join(dir, 'clip.mp4'), { seconds: 1 });
  await fs.writeFile(path.join(dir, 'leeme.txt'), 'texto');
  return dir;
}

// Esta prueba no es sobre duplicados: importa a proposito el mismo archivo
// sintetico una y otra vez. La deteccion se prueba en duplicates.test.js.
require('../src/main/settings-store').saveSettings({ skipDuplicates: false });

test('formatos: todas las extensiones de comprimido se reconocen y el nombre de carpeta es limpio', () => {
  for (const ext of ARCHIVE_EXTENSIONS) assert.equal(isArchiveFile(`x${ext}`), true, ext);
  assert.equal(isArchiveFile('._x.zip'), false, 'basura de macOS');
  assert.equal(isArchiveFile('foto.jpg'), false);
  assert.equal(archiveStem('/a/Vacaciones.tar.gz'), 'Vacaciones');
  assert.equal(archiveStem('/a/Vacaciones.TAR.xz'), 'Vacaciones');
  assert.equal(archiveStem('/a/Boda.7z'), 'Boda');
  assert.equal(archiveStem('/a/Mi.v2.final.zip'), 'Mi.v2.final');
});

const CASES = [
  ['tar', '.tar'], ['tgz', '.tar.gz'], ['tbz2', '.tar.bz2'], ['txz', '.tar.xz'], ['7z', '.7z'], ['rar', '.rar']
];

for (const [kind, ext] of CASES) {
  test(`comprimido ${ext}: se abre, entran fotos y videos con su estructura, y el resto se ignora`, async (t) => {
    if (!HAS_TAR) return t.skip('este equipo no tiene un tar que abra este formato');
    const src = await sampleFolder();
    const archive = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-arch-out-')), `Evento${ext}`);
    if (!makeArchive(kind, src, archive)) return t.skip(`no hay herramienta instalada para fabricar ${ext}`);

    const result = await importPaths([archive]);

    const names = result.importedFiles.map(rel).map((n) => n.replace(/ \(\d+\)/, '')).sort();
    assert.deepEqual(names, ['Evento/Sub/otra.png', 'Evento/clip.mp4', 'Evento/foto.jpg'], 'carpeta con el nombre del comprimido, sin la doble extension');
    assert.deepEqual(result.failedArchives, []);
    assert.equal(result.skippedCount, 1, 'solo leeme.txt se informa');
    assert.equal(result.archiveCount, 1);
    for (const f of result.importedFiles) assert.ok((await fs.stat(f)).size > 0);
    assert.deepEqual(await fs.readdir(path.join(getInputDir(), '.extract')).catch(() => []), [], 'sin carpetas temporales sobrantes');
    await fs.rm(src, { recursive: true, force: true });
  });
}

test('comprimido con contrasena (rar y 7z): se avisa con claridad y no se importa nada', async (t) => {
  if (!HAS_TAR) return t.skip('sin tar');
  for (const [kind, ext] of [['rar-password', '.rar'], ['7z-password', '.7z']]) {
    const src = await sampleFolder();
    const archive = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-arch-pw-')), `Secreto${ext}`);
    if (!makeArchive(kind, src, archive)) continue;
    const result = await importPaths([archive]);
    assert.equal(result.importedFiles.length, 0);
    assert.equal(result.failedArchives.length, 1, ext);
    assert.match(result.failedArchives[0].reason, /contraseña/, ext);
    await fs.rm(src, { recursive: true, force: true });
  }
});

test('un archivo que no es un comprimido real avisa que esta danado, sin romper el resto', async (t) => {
  if (!HAS_TAR) return t.skip('sin tar');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-arch-bad-'));
  await fs.writeFile(path.join(dir, 'falso.rar'), 'esto no es un rar');
  await fs.writeFile(path.join(dir, 'falso.7z'), 'esto tampoco');
  const photo = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#3366aa' } }).jpeg().toBuffer();
  await fs.writeFile(path.join(dir, 'ok.jpg'), photo);

  const result = await importPaths([path.join(dir, 'falso.rar'), path.join(dir, 'falso.7z'), path.join(dir, 'ok.jpg')]);

  assert.equal(result.importedFiles.length, 1);
  assert.equal(result.failedArchives.length, 2);
  for (const f of result.failedArchives) assert.match(f.reason, /dañado|no es compatible/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('comprimidos anidados de formatos distintos: rar dentro de zip y zip dentro de 7z', async (t) => {
  if (!HAS_TAR) return t.skip('sin tar');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-arch-nest-'));
  const src = await sampleFolder();
  const rarPath = path.join(work, 'interno.rar');
  if (!makeArchive('rar', src, rarPath)) return t.skip('sin rar');

  // zip { interno.rar }
  const zipPath = path.join(work, 'externo.zip');
  await fs.writeFile(zipPath, makeZip([{ name: 'interno.rar', data: await fs.readFile(rarPath) }]));
  const a = await importPaths([zipPath]);
  assert.equal(a.importedFiles.length, 3, 'un rar dentro de un zip se abre');
  assert.ok(a.importedFiles.every((f) => rel(f).includes('externo') && rel(f).includes('interno')));

  // 7z { carpeta con un zip }
  if (TOOLS.sevenZip) {
    const holder = path.join(work, 'holder');
    await fs.mkdir(holder);
    await fs.writeFile(path.join(holder, 'dentro.zip'), makeZip([{ name: 'v.mp4', data: await fs.readFile(path.join(src, 'clip.mp4')) }]));
    const sevenPath = path.join(work, 'contenedor.7z');
    if (makeArchive('7z', holder, sevenPath)) {
      const b = await importPaths([sevenPath]);
      assert.equal(b.importedFiles.length, 1, 'un zip dentro de un 7z se abre');
      assert.match(rel(b.importedFiles[0]), /contenedor\/dentro\/v\.mp4$/);
    }
  }
  await fs.rm(work, { recursive: true, force: true });
  await fs.rm(src, { recursive: true, force: true });
});

test('seguridad: ruta con ../ y enlace simbolico dentro de un tar no escapan ni se importan', async (t) => {
  if (!HAS_TAR) return t.skip('sin tar');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-arch-evil-'));
  const photo = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#aa3366' } }).jpeg().toBuffer();
  const archive = path.join(work, 'hostil.tar');
  if (!makeHostileTar(archive, photo)) return t.skip('sin python para fabricar el tar hostil');

  const result = await importPaths([archive]);

  for (const up of [work, path.dirname(work), path.join(work, '..', '..')]) {
    await assert.rejects(fs.access(path.join(up, 'evil.jpg')), `no debe existir ${up}/evil.jpg`);
  }
  const names = result.importedFiles.map((f) => path.basename(f));
  assert.ok(!names.includes('link.jpg'), 'un enlace simbolico nunca se importa (podria apuntar a un archivo ajeno)');
  assert.ok(result.importedFiles.every((f) => f.startsWith(getInputDir())), 'todo queda dentro de input/');
  await fs.rm(work, { recursive: true, force: true });
});

test('limite de tamano al descomprimir: se corta y se avisa (anti bomba)', async (t) => {
  if (!HAS_TAR) return t.skip('sin tar');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-arch-big-'));
  const src = path.join(work, 'src');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, 'grande.jpg'), Buffer.alloc(600000, 1));
  const archive = path.join(work, 'grande.tar.gz');
  if (!makeArchive('tgz', src, archive)) return t.skip('sin tar para fabricar');
  const ctx = createContext({ maxTotalBytes: 100000 });
  ctx.tempRoot = path.join(work, 'tmp');

  const files = await extractArchive(archive, path.join(work, 'out'), ctx);

  assert.deepEqual(files, []);
  assert.equal(ctx.failedArchives.length, 1);
  assert.match(ctx.failedArchives[0].reason, /demasiado grande/);
  await fs.rm(work, { recursive: true, force: true });
});

test('un comprimido sin ninguna foto ni video no deja carpeta vacia', async (t) => {
  if (!HAS_TAR) return t.skip('sin tar');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-arch-empty-'));
  const src = path.join(work, 'src');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, 'solo.txt'), 'x');
  const archive = path.join(work, 'Vacio.tar.gz');
  if (!makeArchive('tgz', src, archive)) return t.skip('sin tar para fabricar');
  const before = await fs.readdir(getInputDir()).catch(() => []);

  const result = await importPaths([archive]);

  assert.equal(result.importedFiles.length, 0);
  assert.equal(result.skippedCount, 1);
  const after = await fs.readdir(getInputDir());
  assert.deepEqual(after.filter((n) => !before.includes(n) && n !== '.extract'), [], 'no queda "Vacio/" en input/');
  await fs.rm(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------- sistemas antiguos
// Un tar viejo (macOS 10.15/11, Windows 10 antiguo) no abre RAR5. Se simula
// con un "tar" que siempre falla (COMPACTA_TAR_PATH=/bin/false) para comprobar
// el respaldo con 7-Zip y el mensaje cuando no hay nada que lo abra.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('tar antiguo que no abre un RAR5: se usa 7-Zip como respaldo si esta instalado', async (t) => {
  if (!TOOLS.rar || !TOOLS.sevenZip || !fsSync.existsSync('/bin/false')) return t.skip('faltan rar, 7z o /bin/false');
  const src = await sampleFolder();
  const archive = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-arch-old-')), 'Antiguo.rar');
  assert.ok(makeArchive('rar-store', src, archive));

  const result = await withEnv({ COMPACTA_TAR_PATH: '/bin/false' }, () => importPaths([archive]));

  assert.equal(result.importedFiles.length, 3, 'las fotos y el video salen igualmente, con 7-Zip');
  assert.deepEqual(result.failedArchives, []);
  assert.equal(result.archiveCount, 1);
  await fs.rm(src, { recursive: true, force: true });
});

test('tar antiguo y sin 7-Zip: el aviso del RAR5 dice la causa real y que hacer (no un generico "danado")', async (t) => {
  if (!TOOLS.rar || !fsSync.existsSync('/bin/false')) return t.skip('faltan rar o /bin/false');
  const src = await sampleFolder();
  const archive = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-arch-old2-')), 'Nuevo.rar');
  assert.ok(makeArchive('rar', src, archive)); // rar crea RAR5 por defecto

  const result = await withEnv({ COMPACTA_TAR_PATH: '/bin/false', COMPACTA_SEVENZIP_PATH: 'none' }, () => importPaths([archive]));

  assert.equal(result.importedFiles.length, 0);
  assert.equal(result.failedArchives.length, 1);
  assert.match(result.failedArchives[0].reason, /RAR5/);
  assert.match(result.failedArchives[0].reason, /ZIP o 7z|7-Zip/, 'indica una salida');
  await fs.rm(src, { recursive: true, force: true });
});

test('con contrasena, el respaldo de 7-Zip tambien avisa de la contrasena (no se queda esperando)', async (t) => {
  if (!TOOLS.rar || !TOOLS.sevenZip || !fsSync.existsSync('/bin/false')) return t.skip('faltan rar, 7z o /bin/false');
  const src = await sampleFolder();
  const archive = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-arch-pw2-')), 'Secreto.rar');
  assert.ok(makeArchive('rar-password', src, archive));

  const result = await withEnv({ COMPACTA_TAR_PATH: '/bin/false' }, () => importPaths([archive]));

  assert.equal(result.importedFiles.length, 0);
  assert.match(result.failedArchives[0].reason, /contraseña/);
  await fs.rm(src, { recursive: true, force: true });
});

test('ni tar ni 7-Zip en el equipo: se avisa con claridad y no se rompe nada', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-arch-none-'));
  await fs.writeFile(path.join(dir, 'x.7z'), 'cualquier cosa');
  const result = await withEnv({ COMPACTA_TAR_PATH: '/no/existe/tar', COMPACTA_SEVENZIP_PATH: 'none' }, () => importPaths([path.join(dir, 'x.7z')]));
  assert.equal(result.importedFiles.length, 0);
  assert.equal(result.failedArchives.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});
