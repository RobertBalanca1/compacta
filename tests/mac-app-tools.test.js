'use strict';

// Herramienta de revision del .app de Mac (scripts/mac-app-tools.js), sobre .app falsos hechos con binarios Mach-O validos.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectApp, isNewer } = require('../scripts/mac-app-tools');
const { thinMacho, fatMacho } = require('./helpers/make-macho');

function fakeApp({ declared = '10.13.0', executable = fatMacho([thinMacho({ arch: 'x64', minos: [10, 13] }), thinMacho({ arch: 'arm64', minos: [11] })]),
  ffmpeg = fatMacho([thinMacho({ arch: 'x64', minos: [10, 13] }), thinMacho({ arch: 'arm64', minos: [12] })]), extra = {} } = {}) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'compacta-app-'));
  const put = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.writeFileSync(path.join(app, rel), data);
  };
  put('Contents/Info.plist', `<plist><dict><key>CFBundleExecutable</key><string>Compacta</string><key>LSMinimumSystemVersion</key><string>${declared}</string></dict></plist>`);
  put('Contents/MacOS/Compacta', executable);
  put('Contents/Resources/ffmpeg/ffmpeg', ffmpeg);
  for (const [rel, data] of Object.entries(extra)) put(rel, data);
  return app;
}
const clean = (app) => fs.rmSync(app, { recursive: true, force: true });

test('isNewer compara versiones de macOS por numeros, no como texto', () => {
  assert.equal(isNewer('13.0.0', '10.13.0'), true);
  assert.equal(isNewer('10.13.0', '10.13'), false);
  assert.equal(isNewer('10.9.0', '10.13.0'), false, '10.9 es MENOR que 10.13 aunque «9» > «13» como texto');
  assert.equal(isNewer('11.0.0', '10.15.7'), true);
});

test('un .app universal en regla no da problemas; el ffmpeg de Apple Silicon (macOS 12) en una antigua queda como nota cubierta por Rosetta', () => {
  const app = fakeApp();
  try {
    const result = inspectApp(app);
    assert.deepEqual(result.problems, []);
    assert.equal(result.declared, '10.13.0');
    assert.equal(result.binaries.length, 2);
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0], /ffmpeg.*arm64.*12\.0\.0.*Rosetta/);
  } finally { clean(app); }
});

test('el mismo ffmpeg en la variante moderna (macOS 13) no genera ni nota', () => {
  const app = fakeApp({ declared: '13.0.0' });
  try {
    const result = inspectApp(app);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.notes, []);
  } finally { clean(app); }
});

test('una pieza que pide MAS macOS del declarado es un problema (la libreria de imagenes de Intel pide 10.15 y el instalador dice 10.13)', () => {
  const app = fakeApp({ extra: { 'Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-darwin-x64/lib/sharp.node': thinMacho({ arch: 'x64', minos: [10, 15] }) } });
  try {
    const { problems } = inspectApp(app);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /sharp\.node \(x64\) pide macOS 10\.15\.0 y el instalador declara 10\.13\.0/);
  } finally { clean(app); }
});

test('en Apple Silicon el suelo es macOS 11: una pieza arm64 de 11.0 no es problema aunque el instalador declare 10.13', () => {
  const app = fakeApp({ extra: { 'Contents/Frameworks/libx.dylib': thinMacho({ arch: 'arm64', minos: [11, 0] }) } });
  try {
    assert.deepEqual(inspectApp(app).problems, []);
  } finally { clean(app); }
});

test('falta la parte Intel o la de Apple Silicon en el ejecutable o en el ffmpeg: problema', () => {
  const app = fakeApp({ executable: thinMacho({ arch: 'arm64', minos: [11] }), ffmpeg: thinMacho({ arch: 'x64', minos: [10, 13] }) });
  try {
    const { problems } = inspectApp(app);
    assert.equal(problems.length, 2);
    assert.match(problems.join('\n'), /El ejecutable .* no lleva la parte Intel/);
    assert.match(problems.join('\n'), /El ffmpeg .* no lleva la parte Apple Silicon/);
  } finally { clean(app); }
});

test('algo que no es un .app, o sin macOS minimo declarado, se dice claramente', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'compacta-app-'));
  try {
    assert.match(inspectApp(empty).problems[0], /no es un \.app/);
    const app = fakeApp();
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleExecutable</key><string>Compacta</string></dict></plist>');
    assert.match(inspectApp(app).problems.join('\n'), /no declara LSMinimumSystemVersion/);
    clean(app);
  } finally { clean(empty); }
});
