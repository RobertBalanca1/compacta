'use strict';

// La ruta de un archivo soltado: `webUtils.getPathForFile` (Electron 29+) o `file.path` (Electron 26, el del instalador
// de Mac para llegar a macOS 10.13/10.14). La interfaz es la misma en los dos.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'preload.js');

function loadPreload(electronStub) {
  const exposed = {};
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
        ipcRenderer: { invoke: () => {}, on: () => {}, removeListener: () => {} },
        ...electronStub
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  delete require.cache[PRELOAD];
  try {
    require(PRELOAD);
  } finally {
    Module._load = originalLoad;
    delete require.cache[PRELOAD];
  }
  return exposed.api;
}

test('con Electron nuevo usa webUtils.getPathForFile', () => {
  const api = loadPreload({ webUtils: { getPathForFile: (file) => `/nuevo/${file.name}` } });
  assert.equal(api.getPathForFile({ name: 'a.jpg', path: '/viejo/a.jpg' }), '/nuevo/a.jpg');
});

test('con Electron 26 (sin webUtils) usa file.path, y no revienta al cargar', () => {
  const api = loadPreload({});
  assert.equal(api.getPathForFile({ name: 'a.jpg', path: '/Users/x/a.jpg' }), '/Users/x/a.jpg');
});

test('el preload expone el sistema operativo y el aviso de pantalla completa', () => {
  const api = loadPreload({});
  assert.equal(api.platform, process.platform);
  assert.equal(typeof api.onFullScreenChange, 'function');
  const off = api.onFullScreenChange(() => {});
  assert.equal(typeof off, 'function', 'devuelve la funcion para dejar de escuchar');
});
