'use strict';

/**
 * Debe coincidir siempre con "build.appId" en package.json.
 *
 * A PROPOSITO no se lee de package.json en tiempo de ejecucion. Se intento
 * asi en la 1.0.6 (`require('../../package.json').build.appId`) y tiraba
 * abajo la app ENTERA nada mas abrirla, con "Cannot read properties of
 * undefined (reading 'appId')": electron-builder QUITA los campos "build",
 * "scripts" y "devDependencies" del package.json que empaqueta dentro de
 * app.asar (son metadatos de la construccion, no de la app en si), asi que
 * ese require funcionaba en desarrollo (donde package.json esta completo) y
 * fallaba SOLO en la app ya instalada -- exactamente el tipo de diferencia
 * que las pruebas anteriores no detectaban, por correr sobre el codigo
 * fuente y no sobre el .asar real. Ver tests/app-id.test.js (compara este
 * valor contra el package.json de verdad para que nunca se desincronicen) y
 * tests/packaged-smoke-test-electron.js (arranca el .asar empaquetado de
 * verdad, no el codigo fuente).
 */
const APP_USER_MODEL_ID = 'com.tuempresa.compacta';

module.exports = { APP_USER_MODEL_ID };
