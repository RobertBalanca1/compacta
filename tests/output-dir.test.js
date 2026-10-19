'use strict';

const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.COMPACTA_TEST_BASE_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'compacta-od-base-'));

const sharp = require('sharp');
const paths = require('../src/main/paths');
const { validateOutputDir, applyConfiguredOutputDir, chooseOutputDir, resetOutputDir } = require('../src/main/output-dir');
const { getOutputPathFor, findUnprocessedFiles, listBatches } = require('../src/main/file-manager');
const { importPaths } = require('../src/main/importer');
const { loadSettings, saveSettings } = require('../src/main/settings-store');
const { QueueManager } = require('../src/main/queue-manager');

const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), `compacta-od-${p}-`));
test.afterEach(() => resetOutputDir());

test('por defecto la salida es Documentos/Compacta/output y no hay carpeta elegida', () => {
  assert.equal(paths.getOutputDir(), paths.getDefaultOutputDir());
  assert.equal(loadSettings().outputDir, null);
});

test('una carpeta valida se acepta, se crea si no existe y se escribe de verdad', async () => {
  const base = await tmp('ok');
  const target = path.join(base, 'nueva', 'Comprimidas');
  const result = await validateOutputDir(target);
  assert.equal(result.ok, true);
  assert.ok((await fs.stat(target)).isDirectory(), 'se creo');
  assert.deepEqual(await fs.readdir(target), [], 'y la prueba de escritura no deja restos');
  await fs.rm(base, { recursive: true, force: true });
});

test('se rechazan: relativa, raiz de disco, un archivo, dentro de input/ y la que CONTIENE a input/', async () => {
  const base = await tmp('bad');
  const file = path.join(base, 'archivo.txt');
  await fs.writeFile(file, 'x');
  const input = paths.getInputDir();
  await fs.mkdir(input, { recursive: true });

  const cases = [
    ['relativa', 'carpeta/relativa', /no es válida/],
    ['raiz del disco', path.parse(base).root, /disco entero/],
    ['un archivo', file, /no es una carpeta/i],
    ['la propia input', input, /dentro de la carpeta de entrada/],
    ['dentro de input', path.join(input, 'sub'), /dentro de la carpeta de entrada/],
    ['la que contiene a input (la base de Compacta)', paths.getBaseDir(), /contiene la carpeta de entrada/],
    ['no es texto', 42, /no es válida/]
  ];
  for (const [name, candidate, pattern] of cases) {
    const result = await validateOutputDir(candidate);
    assert.equal(result.ok, false, name);
    assert.match(result.reason, pattern, name);
  }
  await fs.rm(base, { recursive: true, force: true });
});

test('una carpeta sin permiso de escritura se rechaza con un motivo claro', async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('como root no hay carpetas de solo lectura');
  const base = await tmp('ro');
  const ro = path.join(base, 'solo-lectura');
  await fs.mkdir(ro);
  await fs.chmod(ro, 0o500);
  const result = await validateOutputDir(path.join(ro, 'dentro'));
  assert.equal(result.ok, false);
  assert.match(result.reason, /No se puede escribir/);
  await fs.chmod(ro, 0o700);
  await fs.rm(base, { recursive: true, force: true });
});

test('elegir una carpeta: se guarda, se aplica y las rutas de salida pasan a ella (misma estructura)', async () => {
  const base = await tmp('choose');
  const result = await chooseOutputDir(path.join(base, 'Salida'));
  assert.equal(result.ok, true);
  assert.equal(result.isDefault, false);
  assert.equal(loadSettings().outputDir, path.join(base, 'Salida'));
  assert.equal(paths.getOutputDir(), path.join(base, 'Salida'));

  const input = path.join(paths.getInputDir(), 'Evento', 'Dia1', 'foto.jpg');
  assert.equal(getOutputPathFor(input), path.join(base, 'Salida', 'Evento', 'Dia1', 'foto.jpg'));
  await fs.rm(base, { recursive: true, force: true });
});

test('elegir una carpeta invalida NO cambia nada de lo que habia', async () => {
  const before = paths.getOutputDir();
  const result = await chooseOutputDir(paths.getInputDir());
  assert.equal(result.ok, false);
  assert.equal(paths.getOutputDir(), before);
  assert.equal(loadSettings().outputDir, null);
});

test('restablecer vuelve a la de siempre y borra lo guardado', async () => {
  const base = await tmp('reset');
  await chooseOutputDir(path.join(base, 'X'));
  const back = resetOutputDir();
  assert.equal(back.isDefault, true);
  assert.equal(paths.getOutputDir(), paths.getDefaultOutputDir());
  assert.equal(loadSettings().outputDir, null);
  await fs.rm(base, { recursive: true, force: true });
});

test('al arrancar se aplica lo guardado; y si la carpeta ya no esta disponible, se usa la de siempre y se AVISA (sin borrar la eleccion)', async () => {
  const base = await tmp('boot');
  const chosen = path.join(base, 'Disco externo', 'Fotos');
  await chooseOutputDir(chosen);
  paths.setOutputDirOverride(null); // como un arranque nuevo
  const ok = await applyConfiguredOutputDir();
  assert.equal(ok.dir, chosen);
  assert.equal(ok.fellBackFrom, null);

  // "Desenchufar el disco": el sitio pasa a ser un archivo, asi que ni existe como carpeta ni se puede crear.
  await fs.rm(path.join(base, 'Disco externo'), { recursive: true, force: true });
  await fs.writeFile(path.join(base, 'Disco externo'), 'ya no es una carpeta');
  const gone = await applyConfiguredOutputDir();
  assert.equal(gone.dir, paths.getDefaultOutputDir(), 'vuelve a la de siempre');
  assert.equal(gone.fellBackFrom, chosen, 'y dice cual era la que no esta');
  assert.equal(loadSettings().outputDir, chosen, 'la eleccion NO se borra: vuelve sola al reconectar el disco');

  await fs.rm(path.join(base, 'Disco externo'), { force: true });
  const back = await applyConfiguredOutputDir();
  assert.equal(back.dir, chosen, 'al volver el disco, se usa otra vez');
  assert.equal(back.fellBackFrom, null);
  await fs.rm(base, { recursive: true, force: true });
});

test('lo ya procesado en la carpeta ANTERIOR no se repite al cambiar de carpeta (el registro es por archivo de entrada)', async () => {
  saveSettings({ skipDuplicates: false });
  const base = await tmp('norepeat');
  const src = path.join(base, 'src', 'Lote');
  await fs.mkdir(src, { recursive: true });
  await sharp({ create: { width: 400, height: 300, channels: 3, noise: { type: 'gaussian', mean: 100, sigma: 50 } } }).jpeg({ quality: 97 }).toFile(path.join(src, 'a.jpg'));

  const qm = new QueueManager();
  const done = new Promise((r) => qm.once('batch-finished', r));
  const imported = await importPaths([src]);
  qm.addJobs(imported.importedFiles.map((inputPath) => ({ inputPath, outputPath: getOutputPathFor(inputPath) })));
  await done;
  assert.equal((await findUnprocessedFiles(await listBatches())).length, 0, 'todo hecho');

  await chooseOutputDir(path.join(base, 'OtraSalida'));
  assert.equal((await findUnprocessedFiles(await listBatches())).length, 0, 'tras cambiar de carpeta sigue sin haber nada pendiente');
  await fs.rm(base, { recursive: true, force: true });
});

test('comparacion de rutas: "input" y "INPUT" son la misma carpeta en Windows y macOS (no en Linux)', async () => {
  const upper = paths.getInputDir().replace(/input$/, 'INPUT');
  const result = await validateOutputDir(path.join(upper, 'x'));
  if (process.platform === 'linux') assert.equal(result.ok, true, 'en Linux son carpetas distintas');
  else assert.equal(result.ok, false, 'en Windows y macOS es la misma');
});
