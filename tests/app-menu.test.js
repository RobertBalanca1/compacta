'use strict';

// Menu de macOS: funcion pura (plantilla), probada sin un Mac.

const test = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../src/shared/i18n');
const { buildMenuTemplate, refreshAppMenu } = require('../src/main/app-menu');

const build = (extra = {}) => buildMenuTemplate({ appName: 'Compacta', translate: i18n.t, ...extra });
const find = (template, label) => template.find((entry) => entry.label === label);
const flatten = (template) => template.flatMap((entry) => [entry, ...(entry.submenu ? flatten(entry.submenu) : [])]);

test.afterEach(() => i18n.setLanguage('es'));

test('el menu trae Archivo, Edicion, Visualizacion y Ventana; el de la app va primero', () => {
  const labels = build().map((entry) => entry.label);
  assert.deepEqual(labels, ['Compacta', 'Archivo', 'Edición', 'Visualización', 'Ventana']);
});

test('«Edicion» tiene deshacer, rehacer, cortar, copiar, pegar y seleccionar todo (sin ellos ⌘C/⌘V no funcionan en Mac)', () => {
  const edit = find(build(), 'Edición');
  const roles = edit.submenu.map((item) => item.role).filter(Boolean);
  assert.deepEqual(roles, ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
});

test('el menu de la app permite ocultar y salir (⌘H, ⌘Q) con el nombre de la app', () => {
  const app = build()[0].submenu;
  assert.deepEqual(app.map((item) => item.role).filter(Boolean), ['about', 'hide', 'hideOthers', 'unhide', 'quit']);
  assert.equal(app[0].label, 'Acerca de Compacta');
  assert.equal(app.find((item) => item.role === 'quit').label, 'Salir de Compacta');
});

test('las herramientas de desarrollo NO estan a la vista de la gente; solo con devTools (npm run dev)', () => {
  assert.equal(flatten(build()).some((item) => item.role === 'toggleDevTools'), false);
  assert.equal(flatten(build({ devTools: true })).some((item) => item.role === 'toggleDevTools'), true);
});

test('Archivo > Abrir carpeta de salida llama a la funcion recibida, con atajo ⇧⌘O', () => {
  let opened = 0;
  const item = find(build({ openOutput: () => { opened += 1; } }), 'Archivo').submenu[0];
  assert.equal(item.accelerator, 'Shift+CommandOrControl+O');
  item.click();
  assert.equal(opened, 1);
  assert.doesNotThrow(() => build().find((entry) => entry.label === 'Archivo').submenu[0].click(), 'sin funcion no revienta');
});

test('en los 6 idiomas todas las etiquetas existen (ninguna sale como clave «menu.xxx») y siguen el idioma de la app', () => {
  const seen = new Set();
  for (const code of i18n.CODES) {
    i18n.setLanguage(code);
    const template = build();
    for (const item of flatten(template)) {
      if (item.type === 'separator') continue;
      if (item.label !== undefined) {
        assert.ok(String(item.label).trim().length > 0, `${code}: etiqueta vacía`);
        assert.doesNotMatch(item.label, /^menu\./, `${code}: clave sin traducir (${item.label})`);
      }
    }
    seen.add(template[2].label); // «Edición» en cada idioma
    assert.match(template[0].submenu[0].label, /Compacta/, `${code}: «Acerca de» lleva el nombre de la app`);
  }
  assert.equal(seen.size, 6, 'cada idioma tiene su propia palabra para «Edición»');
});

function fakeElectron() {
  const calls = { menu: [], opened: [] };
  return {
    calls,
    electron: {
      app: { name: 'Compacta' },
      shell: { openPath: (dir) => calls.opened.push(dir) },
      Menu: {
        setApplicationMenu: (menu) => calls.menu.push(menu),
        buildFromTemplate: (template) => ({ template })
      }
    }
  };
}

test('Windows y Linux: se QUITA el menu de ejemplo de Electron (trae «Herramientas de desarrollo»), no se instala el de Mac', () => {
  for (const platform of ['win32', 'linux']) {
    const { electron, calls } = fakeElectron();
    assert.equal(refreshAppMenu({ platform, electron, devTools: false }), true);
    assert.deepEqual(calls.menu, [null], `${platform}: sin menu`);
  }
});

test('en desarrollo (--dev) Windows y Linux conservan el menu de Electron, con sus herramientas', () => {
  const { electron, calls } = fakeElectron();
  assert.equal(refreshAppMenu({ platform: 'win32', electron, devTools: true }), false);
  assert.deepEqual(calls.menu, []);
});

test('macOS: se instala el menu propio, con la carpeta de salida enlazada', () => {
  const { electron, calls } = fakeElectron();
  assert.equal(refreshAppMenu({ platform: 'darwin', electron, devTools: false }), true);
  assert.equal(calls.menu.length, 1);
  const labels = calls.menu[0].template.map((entry) => entry.label);
  assert.deepEqual(labels, ['Compacta', 'Archivo', 'Edición', 'Visualización', 'Ventana']);
  const open = calls.menu[0].template.find((entry) => entry.label === 'Archivo').submenu[0];
  open.click();
  assert.equal(calls.opened.length, 1, 'abre la carpeta de salida');
});
