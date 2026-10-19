'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

async function freshManifestStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-manifest-'));
  process.env.COMPACTA_TEST_BASE_DIR = dir;
  delete require.cache[require.resolve('../src/main/manifest-store')];
  delete require.cache[require.resolve('../src/main/paths')];
  const manifestStore = require('../src/main/manifest-store');
  const { getInputDir } = require('../src/main/paths');
  return { manifestStore, dir, inputDir: getInputDir() };
}

test('markDone + isMarkedDone: una foto marcada queda registrada', async () => {
  const { manifestStore, inputDir } = await freshManifestStore();
  const inputPath = path.join(inputDir, 'Lote1', 'foto.jpg');

  assert.equal(manifestStore.isMarkedDone(inputPath), false, 'antes de marcarla no deberia constar como hecha');
  manifestStore.markDone(inputPath);
  assert.equal(manifestStore.isMarkedDone(inputPath), true);
});

test('isMarkedDone sin archivo de manifiesto todavia no falla, devuelve false', async () => {
  const { manifestStore, inputDir } = await freshManifestStore();
  const inputPath = path.join(inputDir, 'nunca-procesada.jpg');
  assert.equal(manifestStore.isMarkedDone(inputPath), false);
});

test('forget quita una foto del registro', async () => {
  const { manifestStore, inputDir } = await freshManifestStore();
  const inputPath = path.join(inputDir, 'foto.jpg');
  manifestStore.markDone(inputPath);
  assert.equal(manifestStore.isMarkedDone(inputPath), true);

  manifestStore.forget(inputPath);
  assert.equal(manifestStore.isMarkedDone(inputPath), false);
});

test('el registro sobrevive a releer el modulo (persiste en disco, no solo en memoria)', async () => {
  const { manifestStore, inputDir } = await freshManifestStore();
  const inputPath = path.join(inputDir, 'Sub', 'foto.jpg');
  manifestStore.markDone(inputPath);
  manifestStore.flush(); // lo mismo que ocurre al vaciarse la cola o cerrar la app

  delete require.cache[require.resolve('../src/main/manifest-store')];
  const manifestStoreRecargado = require('../src/main/manifest-store');
  assert.equal(manifestStoreRecargado.isMarkedDone(inputPath), true);
});

test('un archivo de manifiesto corrupto no rompe la app, se trata como vacio', async () => {
  const { manifestStore, dir, inputDir } = await freshManifestStore();
  const { getManifestFilePath } = require('../src/main/paths');
  await fs.mkdir(path.dirname(getManifestFilePath()), { recursive: true });
  await fs.writeFile(getManifestFilePath(), '{ esto no es json valido ', 'utf-8');

  const inputPath = path.join(inputDir, 'foto.jpg');
  assert.equal(manifestStore.isMarkedDone(inputPath), false, 'manifiesto corrupto se trata como sin marcas, no como error');

  await fs.rm(dir, { recursive: true, force: true });
});
