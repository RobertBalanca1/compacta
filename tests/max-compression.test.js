'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

async function freshSettings() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-maxc-'));
  process.env.COMPACTA_TEST_BASE_DIR = dir;
  for (const m of ['settings-store', 'paths']) delete require.cache[require.resolve(`../src/main/${m}`)];
  return require('../src/main/settings-store');
}

test('"Compresion maxima" esta apagada por defecto y se guarda por perfil', async () => {
  const store = await freshSettings();
  assert.equal(store.loadSettings().maxCompression, false);

  store.saveSettings({ maxCompression: true });
  const withProfile = store.createProfile('Para imprimir');
  assert.equal(withProfile.maxCompression, true, 'un perfil nuevo hereda lo que hay en uso');

  const back = store.switchProfile('default');
  assert.equal(back.maxCompression, true, 'el perfil por defecto recuerda el cambio hecho mientras estaba activo');

  store.saveSettings({ maxCompression: false });
  const toPrint = store.switchProfile(withProfile.activeProfileId);
  assert.equal(toPrint.maxCompression, true, 'el otro perfil conserva el suyo');
});

test('un perfil guardado por una version anterior (sin el campo) cuenta como modo rapido', async () => {
  await freshSettings(); // fija el directorio de datos aislado de esta prueba
  const { getSettingsFilePath } = require('../src/main/paths');
  await fs.mkdir(path.dirname(getSettingsFilePath()), { recursive: true });
  await fs.writeFile(getSettingsFilePath(), JSON.stringify({
    quality: 85, aggressive: false, convertToWebp: false, activeProfileId: 'p1',
    profiles: [{ id: 'p1', name: 'Viejo', quality: 85, aggressive: false, convertToWebp: false }]
  }));
  delete require.cache[require.resolve('../src/main/settings-store')];
  const reloaded = require('../src/main/settings-store');
  const switched = reloaded.switchProfile('p1');
  assert.equal(switched.maxCompression, false);
  assert.equal(switched.quality, 85);
});

test('el optimizador produce JPEG validos y mas pequenos en los dos modos', async () => {
  const { optimizeImage } = require('../src/main/processor/raster-optimizer');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-maxc-img-'));
  const input = path.join(dir, 'foto.jpg');
  await sharp({ create: { width: 1200, height: 800, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 30 } } })
    .blur(1).jpeg({ quality: 97 }).toFile(input);

  for (const maxCompression of [false, true]) {
    const out = path.join(dir, `out-${maxCompression}`, 'foto.jpg');
    const report = await optimizeImage(input, out, { quality: 85, maxCompression });
    assert.equal(report.skipped, false);
    assert.ok(report.newBytes < report.originalBytes);
    assert.equal((await sharp(out).metadata()).format, 'jpeg');
  }
  await fs.rm(dir, { recursive: true, force: true });
});
