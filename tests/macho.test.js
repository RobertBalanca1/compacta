'use strict';

// Lector de cabeceras Mach-O (src/main/macho.js): arquitecturas y macOS minimo, con binarios fabricados (tests/helpers/make-macho.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { machoArchitectures, machoMinOs, readMachoArchitectures, readMachoSlices } = require('../src/main/macho');
const { thinMacho, fatMacho } = require('./helpers/make-macho');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'compacta-macho-'));

test('machoArchitectures lee las arquitecturas de un binario fat (de 32 y de 64 bits), de uno normal y de lo que no es Mach-O', () => {
  const x64 = thinMacho({ arch: 'x64', minos: [10, 13] });
  const arm = thinMacho({ arch: 'arm64', minos: [11] });
  assert.deepEqual(machoArchitectures(fatMacho([x64, arm])), ['x64', 'arm64']);
  assert.deepEqual(machoArchitectures(fatMacho([arm, x64], { bits64: true })), ['arm64', 'x64']);
  assert.deepEqual(machoArchitectures(fatMacho([arm])), ['arm64']);
  assert.deepEqual(machoArchitectures(x64), ['x64'], 'Mach-O de una sola arquitectura (little-endian)');
  assert.deepEqual(machoArchitectures(Buffer.from('#!/bin/sh\necho hola\n')), []);
  assert.deepEqual(machoArchitectures(Buffer.alloc(3)), []);
  assert.deepEqual(machoArchitectures(null), []);
  const unknownCpu = thinMacho({ arch: 'x64', minos: [10, 13] });
  unknownCpu.writeUInt32LE(0x12345678, 4);
  assert.deepEqual(machoArchitectures(fatMacho([unknownCpu])), [], 'una CPU desconocida no se cuenta');
});

test('machoMinOs lee el macOS minimo con LC_BUILD_VERSION y con el comando antiguo LC_VERSION_MIN_MACOSX', () => {
  assert.equal(machoMinOs(thinMacho({ arch: 'x64', minos: [10, 13, 0] })), '10.13.0');
  assert.equal(machoMinOs(thinMacho({ arch: 'arm64', minos: [13, 0, 0] })), '13.0.0');
  assert.equal(machoMinOs(thinMacho({ arch: 'x64', minos: [10, 15, 4], command: 'min' })), '10.15.4');
  assert.equal(machoMinOs(thinMacho({ arch: 'x64', minos: [10, 13], command: null })), null, 'sin comando de version');
  assert.equal(machoMinOs(Buffer.alloc(10)), null);
  assert.equal(machoMinOs(null), null);
  const truncated = thinMacho({ arch: 'x64', minos: [10, 13] }).subarray(0, 36);
  assert.equal(machoMinOs(truncated), null, 'comandos cortados: no inventa un valor');
});

test('readMachoSlices lee de un archivo cada arquitectura con su macOS minimo (fat de 32 y 64 bits, y normal)', () => {
  const dir = tmp();
  try {
    const fat = path.join(dir, 'fat');
    fs.writeFileSync(fat, fatMacho([thinMacho({ arch: 'x64', minos: [10, 13] }), thinMacho({ arch: 'arm64', minos: [12] })]));
    assert.deepEqual(readMachoSlices(fat), [{ arch: 'x64', minos: '10.13.0' }, { arch: 'arm64', minos: '12.0.0' }]);

    const fat64 = path.join(dir, 'fat64');
    fs.writeFileSync(fat64, fatMacho([thinMacho({ arch: 'arm64', minos: [11] })], { bits64: true }));
    assert.deepEqual(readMachoSlices(fat64), [{ arch: 'arm64', minos: '11.0.0' }]);

    const thin = path.join(dir, 'thin');
    fs.writeFileSync(thin, thinMacho({ arch: 'x64', minos: [10, 15], command: 'min' }));
    assert.deepEqual(readMachoSlices(thin), [{ arch: 'x64', minos: '10.15.0' }]);
    assert.deepEqual(readMachoArchitectures(fat), ['x64', 'arm64']);

    const text = path.join(dir, 'texto.js');
    fs.writeFileSync(text, '#!/usr/bin/env node\nconsole.log(1);\n'.repeat(10));
    assert.deepEqual(readMachoSlices(text), []);
    assert.deepEqual(readMachoSlices(path.join(dir, 'no-existe')), []);
    assert.deepEqual(readMachoArchitectures(path.join(dir, 'no-existe')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
