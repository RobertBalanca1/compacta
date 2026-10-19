'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');
const { APP_USER_MODEL_ID } = require('../src/main/app-id');

test('APP_USER_MODEL_ID coincide con build.appId de package.json', () => {
  // app-id.js escribe este valor a mano A PROPOSITO (ver el comentario en
  // ese archivo: electron-builder quita "build" de package.json en el
  // paquete final, asi que no se puede leer de ahi en tiempo de ejecucion).
  // Esta prueba es la que evita que los dos se desincronicen con el tiempo.
  assert.equal(
    APP_USER_MODEL_ID,
    pkg.build.appId,
    'src/main/app-id.js y package.json (build.appId) deben tener siempre el mismo valor'
  );
});
