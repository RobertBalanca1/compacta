'use strict';

// Cada test usa su propia carpeta temporal (via COMPACTA_TEST_BASE_DIR) para
// no compartir el archivo de ajustes entre pruebas ni con una instalacion
// real de la app.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-settings-'));
  process.env.COMPACTA_TEST_BASE_DIR = dir;
  // settings-store cachea rutas via paths.js, que a su vez lee la env var en
  // cada llamada (no la memoriza al cargar el modulo), asi que basta con
  // requerir el modulo fresco cada vez para aislar completamente cada test.
  delete require.cache[require.resolve('../src/main/settings-store')];
  delete require.cache[require.resolve('../src/main/paths')];
  const store = require('../src/main/settings-store');
  return { store, dir };
}

test('loadSettings sin archivo previo devuelve un unico perfil "Por defecto"', async () => {
  const { store } = await freshStore();
  const settings = store.loadSettings();
  assert.equal(settings.profiles.length, 1);
  assert.equal(settings.profiles[0].name, 'Por defecto');
  assert.equal(settings.activeProfileId, settings.profiles[0].id);
  assert.equal(settings.quality, 90);
});

test('createProfile agrega un perfil nuevo, lo activa, y no toca los demas', async () => {
  const { store } = await freshStore();
  const next = store.createProfile('Para proyector', { quality: 70, aggressive: true, convertToWebp: true });

  assert.equal(next.profiles.length, 2);
  const nuevo = next.profiles.find((p) => p.name === 'Para proyector');
  assert.ok(nuevo, 'el perfil nuevo debe existir');
  assert.equal(next.activeProfileId, nuevo.id, 'el perfil nuevo queda activo');
  assert.equal(next.quality, 70, 'los ajustes en uso reflejan el perfil recien creado');
  assert.equal(next.aggressive, true);
  assert.equal(next.convertToWebp, true);

  const original = next.profiles.find((p) => p.name === 'Por defecto');
  assert.equal(original.quality, 90, 'el perfil original no debe modificarse');
});

test('switchProfile cambia los ajustes en uso a los del perfil elegido', async () => {
  const { store } = await freshStore();
  const afterCreate = store.createProfile('Archivo', { quality: 95, aggressive: false, convertToWebp: false });
  const defaultId = afterCreate.profiles.find((p) => p.name === 'Por defecto').id;

  const afterSwitch = store.switchProfile(defaultId);
  assert.equal(afterSwitch.activeProfileId, defaultId);
  assert.equal(afterSwitch.quality, 90);
});

test('saveSettings actualiza el perfil activo in situ, para que sobreviva a cambiar de perfil y volver', async () => {
  const { store } = await freshStore();
  // Perfil activo por defecto es "Por defecto" (quality 90). Lo tocamos.
  store.saveSettings({ quality: 55 });
  const afterCreate = store.createProfile('Otro', { quality: 20 });
  const defaultId = afterCreate.profiles.find((p) => p.name === 'Por defecto').id;

  const afterSwitchBack = store.switchProfile(defaultId);
  assert.equal(afterSwitchBack.quality, 55, 'el ajuste manual sobre "Por defecto" debe conservarse');
});

test('deleteProfile no permite borrar el ultimo perfil restante', async () => {
  const { store } = await freshStore();
  const settings = store.loadSettings();
  const onlyId = settings.profiles[0].id;

  const after = store.deleteProfile(onlyId);
  assert.equal(after.profiles.length, 1, 'debe seguir habiendo exactamente un perfil');
});

test('deleteProfile del perfil activo cae a otro perfil valido automaticamente', async () => {
  const { store } = await freshStore();
  const afterCreate = store.createProfile('Temporal', { quality: 30 });
  const temporalId = afterCreate.activeProfileId;

  const afterDelete = store.deleteProfile(temporalId);
  assert.equal(afterDelete.profiles.length, 1);
  assert.notEqual(afterDelete.activeProfileId, temporalId);
  assert.equal(afterDelete.quality, 90, 'vuelve a los valores del perfil que quedo activo');
});

test('renameProfile cambia el nombre sin afectar los valores de compresion', async () => {
  const { store } = await freshStore();
  const settings = store.loadSettings();
  const id = settings.profiles[0].id;

  const renamed = store.renameProfile(id, '  Mi perfil  ');
  const perfil = renamed.profiles.find((p) => p.id === id);
  assert.equal(perfil.name, 'Mi perfil', 'se recorta espacios sobrantes');
  assert.equal(perfil.quality, 90);
});

test('heicAlwaysJpg: es un ajuste de compresión (va en el perfil), por defecto apagado, y solo admite sí/no', () => {
  const { loadSettings, saveSettings, createProfile, switchProfile } = require('../src/main/settings-store');
  assert.equal(loadSettings().heicAlwaysJpg, false);
  assert.equal(saveSettings({ heicAlwaysJpg: true }).heicAlwaysJpg, true);
  const active = loadSettings().profiles.find((p) => p.id === loadSettings().activeProfileId);
  assert.equal(active.heicAlwaysJpg, true, 'queda guardado en el perfil activo');
  const created = createProfile('Para compartir', { heicAlwaysJpg: false });
  assert.equal(loadSettings().heicAlwaysJpg, false, 'cada perfil tiene el suyo');
  switchProfile('default');
  assert.equal(loadSettings().heicAlwaysJpg, true, 'al volver al perfil anterior, vuelve su valor');
  assert.equal(saveSettings({ heicAlwaysJpg: 'basura' }).heicAlwaysJpg, true, 'cualquier valor se interpreta como sí/no');
  saveSettings({ heicAlwaysJpg: false });
  assert.ok(created);
});
