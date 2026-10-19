'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSupportedImage,
  isPotentiallyAnimated,
  formatFromExtension,
  getExtension
} = require('../src/main/processor/formats');

test('detecta extensiones soportadas', () => {
  assert.equal(isSupportedImage('/a/foto.JPG'), true);
  assert.equal(isSupportedImage('/a/foto.png'), true);
  assert.equal(isSupportedImage('/a/documento.pdf'), false);
  assert.equal(isSupportedImage('/a/sin_extension'), false);
});

test('identifica formatos con riesgo de animacion', () => {
  assert.equal(isPotentiallyAnimated('/a/animacion.gif'), true);
  assert.equal(isPotentiallyAnimated('/a/foto.webp'), true);
  assert.equal(isPotentiallyAnimated('/a/foto.jpg'), false);
});

test('mapea extension a formato interno', () => {
  assert.equal(formatFromExtension('.jpg'), 'jpeg');
  assert.equal(formatFromExtension('.jpeg'), 'jpeg');
  assert.equal(formatFromExtension('.png'), 'png');
  assert.equal(formatFromExtension('.xyz'), null);
});

test('extrae la extension en minuscula sin importar el original', () => {
  assert.equal(getExtension('/a/FOTO.PNG'), '.png');
  assert.equal(getExtension('/a/sin_punto'), '');
});

test('nombres con tilde: compuesto (NFC) y descompuesto (NFD) cuentan como el mismo (caso tipico de macOS)', () => {
  const { candidateOutputFileNames, foldName } = require('../src/main/processor/formats');
  const nfc = 'Canci\u00f3n.mov';
  const nfd = 'Cancio\u0301n.mov';
  assert.notEqual(nfc, nfd, 'las dos formas son textos distintos');
  assert.equal(foldName(nfc), foldName(nfd));
  const outputOnDisk = new Set(['cancio\u0301n.mp4'.normalize('NFD')]); // asi lo dejaria HFS+
  const folded = new Set([...outputOnDisk].map(foldName));
  assert.ok(candidateOutputFileNames('/x/' + nfc).some((n) => folded.has(n)), 'se reconoce como ya procesado');
});
