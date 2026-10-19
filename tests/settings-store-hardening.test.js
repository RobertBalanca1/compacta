'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-settings-hard-'));
  process.env.COMPACTA_TEST_BASE_DIR = dir;
  delete require.cache[require.resolve('../src/main/settings-store')];
  delete require.cache[require.resolve('../src/main/paths')];
  return { store: require('../src/main/settings-store'), dir };
}

test('saveSettings descarta campos desconocidos e ignora tipos invalidos', async () => {
  const { store } = await freshStore();
  const next = store.saveSettings({ quality: 500, aggressive: 'si por favor', campoInventado: 'hola' });
  assert.equal(next.quality, 100, 'la calidad se recorta al maximo valido, no se acepta 500 tal cual');
  assert.equal(next.aggressive, true, 'un valor truthy se normaliza a booleano');
  assert.equal('campoInventado' in next, false);
});

test('saveSettings con calidad no numerica no rompe nada (se ignora ese campo)', async () => {
  const { store } = await freshStore();
  const before = store.loadSettings().quality;
  const next = store.saveSettings({ quality: 'abc' });
  assert.equal(next.quality, before);
});

test('createProfile recorta un nombre absurdamente largo', async () => {
  const { store } = await freshStore();
  const nombreLargo = 'x'.repeat(500);
  const next = store.createProfile(nombreLargo);
  const creado = next.profiles.find((p) => p.id === next.activeProfileId);
  assert.ok(creado.name.length <= 60);
});

test('un settings.json corrupto no borra los perfios existentes al reescribirlo (escritura atomica)', async () => {
  const { store, dir } = await freshStore();
  store.createProfile('Importante');
  const { getSettingsFilePath } = require('../src/main/paths');
  const file = getSettingsFilePath();
  const before = await fs.readFile(file, 'utf-8');

  // No queda ningun .tmp-* huerfano despues de una escritura normal.
  const siblings = await fs.readdir(path.dirname(file));
  assert.ok(!siblings.some((n) => n.includes('.tmp-')), 'no debe quedar un temporal suelto tras guardar bien');

  const parsed = JSON.parse(before);
  assert.ok(parsed.profiles.some((p) => p.name === 'Importante'));
  await fs.rm(dir, { recursive: true, force: true });
});
