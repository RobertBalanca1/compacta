'use strict';

// Lo que depende del sistema operativo, probado sin necesitar ese sistema:
// la comprobacion de macOS en Apple Silicon es una funcion pura.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { videoEngineProblem, getFfmpegPath, ffmpegLaunch, machoArchitectures, needsRosetta } = require('../src/main/processor/ffmpeg');

test('Apple Silicon con macOS 11 (Darwin 20) SIN Rosetta: se avisa ANTES de lanzar ffmpeg, con dos salidas', () => {
  const msg = videoEngineProblem({ platform: 'darwin', arch: 'arm64', release: '20.6.0', canUseRosetta: false });
  assert.match(msg, /macOS 12/);
  assert.match(msg, /softwareupdate --install-rosetta/, 'dice como instalar Rosetta, la salida que no obliga a actualizar');
  assert.doesNotMatch(msg, /Mac Intel/, 'ya no hay una version aparte para Mac Intel: el instalador es uno solo');
  assert.match(msg, /fotos s[ií] se comprimen/i, 'aclara que lo demas no se ve afectado');
});

test('Apple Silicon con macOS 11 CON Rosetta: no hay problema, se usa la parte Intel del ffmpeg', () => {
  assert.equal(videoEngineProblem({ platform: 'darwin', arch: 'arm64', release: '20.6.0', canUseRosetta: true }), null);
});

test('macOS 12+ en Apple Silicon, y cualquier Mac Intel, Windows o Linux: sin problema', () => {
  for (const release of ['21.0.0', '22.6.0', '23.5.0', '24.0.0', '25.1.0']) {
    assert.equal(videoEngineProblem({ platform: 'darwin', arch: 'arm64', release }), null, `Darwin ${release}`);
  }
  for (const release of ['17.7.0', '18.7.0', '19.6.0', '20.6.0']) {
    assert.equal(videoEngineProblem({ platform: 'darwin', arch: 'x64', release }), null, `Intel, Darwin ${release}: su ffmpeg pide macOS 10.13`);
  }
  assert.equal(videoEngineProblem({ platform: 'win32', arch: 'x64', release: '10.0.19045' }), null);
  assert.equal(videoEngineProblem({ platform: 'linux', arch: 'x64', release: '6.1.0' }), null);
  assert.equal(videoEngineProblem({ platform: 'darwin', arch: 'arm64', release: 'rara' }), null, 'una version ilegible no bloquea');
});

test('el ffmpeg de desarrollo sale de vendor/ffmpeg/<plataforma>-<arquitectura>/ si esta preparado', () => {
  const saved = process.env.COMPACTA_FFMPEG_PATH;
  delete process.env.COMPACTA_FFMPEG_PATH;
  try {
    const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const vendored = path.join(__dirname, '..', 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`, exe);
    const resolved = getFfmpegPath();
    assert.ok(fs.existsSync(resolved), 'el binario resuelto existe');
    if (fs.existsSync(vendored)) assert.equal(resolved, vendored, 'vendor/ tiene prioridad sobre ffmpeg-static');
  } finally {
    if (saved !== undefined) process.env.COMPACTA_FFMPEG_PATH = saved;
  }
});

test('COMPACTA_FFMPEG_PATH manda sobre todo lo demas', () => {
  const saved = process.env.COMPACTA_FFMPEG_PATH;
  process.env.COMPACTA_FFMPEG_PATH = '/ruta/forzada/ffmpeg';
  try {
    assert.equal(getFfmpegPath(), '/ruta/forzada/ffmpeg');
  } finally {
    if (saved === undefined) delete process.env.COMPACTA_FFMPEG_PATH;
    else process.env.COMPACTA_FFMPEG_PATH = saved;
  }
});

// ---- Mac: un solo instalador (Intel + Apple Silicon) y el ffmpeg "fat" que lleva dentro ----

/** Cabecera de un Mach-O "fat" como la que deja `lipo`: 0xCAFEBABE, n, y n entradas de 20 bytes (todo big-endian). */
function fatHeader(cpuTypes) {
  const buf = Buffer.alloc(8 + cpuTypes.length * 20);
  buf.writeUInt32BE(0xcafebabe, 0);
  buf.writeUInt32BE(cpuTypes.length, 4);
  cpuTypes.forEach((cpu, i) => buf.writeUInt32BE(cpu, 8 + i * 20));
  return buf;
}
const X64 = 0x01000007;
const ARM64 = 0x0100000c;

test('machoArchitectures lee las arquitecturas de un binario fat, de uno normal y de lo que no es Mach-O', () => {
  assert.deepEqual(machoArchitectures(fatHeader([X64, ARM64])), ['x64', 'arm64']);
  assert.deepEqual(machoArchitectures(fatHeader([ARM64])), ['arm64']);
  const thin = Buffer.alloc(32);
  thin.writeUInt32LE(0xfeedfacf, 0);
  thin.writeUInt32LE(X64, 4);
  assert.deepEqual(machoArchitectures(thin), ['x64'], 'Mach-O de una sola arquitectura (little-endian)');
  assert.deepEqual(machoArchitectures(Buffer.from('#!/bin/sh\necho hola\n')), []);
  assert.deepEqual(machoArchitectures(Buffer.alloc(3)), []);
  assert.deepEqual(machoArchitectures(null), []);
  assert.deepEqual(machoArchitectures(fatHeader([0x12345678])), [], 'una CPU desconocida no se cuenta');
});

test('needsRosetta: solo Apple Silicon con macOS anterior a 12; una version ilegible no lo activa', () => {
  assert.equal(needsRosetta({ platform: 'darwin', arch: 'arm64', release: '20.6.0' }), true);
  assert.equal(needsRosetta({ platform: 'darwin', arch: 'arm64', release: '21.0.0' }), false);
  assert.equal(needsRosetta({ platform: 'darwin', arch: 'arm64', release: '25.0.0' }), false, 'macOS 26 (Darwin 25)');
  assert.equal(needsRosetta({ platform: 'darwin', arch: 'x64', release: '19.6.0' }), false);
  assert.equal(needsRosetta({ platform: 'win32', arch: 'arm64', release: '10.0.22000' }), false);
  assert.equal(needsRosetta({ platform: 'darwin', arch: 'arm64', release: 'rara' }), false);
});

test('ffmpegLaunch: normalmente es el propio binario; con Rosetta antepone `arch -x86_64`', () => {
  assert.deepEqual(ffmpegLaunch(['-i', 'a.mp4'], { binary: '/x/ffmpeg', rosetta: false }), { command: '/x/ffmpeg', args: ['-i', 'a.mp4'] });
  assert.deepEqual(ffmpegLaunch(['-i', 'a.mp4'], { binary: '/x/ffmpeg', rosetta: true }), { command: '/usr/bin/arch', args: ['-x86_64', '/x/ffmpeg', '-i', 'a.mp4'] });
  // En esta maquina (no es un Mac con macOS 11) nunca se usa Rosetta por su cuenta.
  assert.equal(ffmpegLaunch(['-version'], { binary: '/x/ffmpeg' }).command, '/x/ffmpeg');
});
