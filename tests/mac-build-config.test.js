'use strict';

// El instalador de Mac, vigilado: UN solo archivo, para Intel y Apple Silicon, y que llegue a macOS 10.13/10.14.
// Si alguien cambia algo de package.json que rompa esas promesas, esta prueba lo dice (ver DOCUMENTACION 7.23).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const mac = pkg.build.mac;

test('Mac: UN solo instalador (un .dmg universal), no uno por arquitectura ni .zip aparte', () => {
  assert.equal(mac.target.length, 1, 'un solo target');
  assert.equal(mac.target[0].target, 'dmg');
  assert.deepEqual(mac.target[0].arch, ['universal'], 'Intel y Apple Silicon juntos');
  assert.match(pkg.scripts['dist:mac'], /--universal/);
  assert.doesNotMatch(pkg.scripts['dist:mac'], /--x64|--arm64/);
  assert.match(mac.artifactName, /Mac\.\$\{ext\}$/, 'nombre claro: Compacta-X.Y.Z-Mac.dmg');
});

test('Mac: el instalador llega a macOS 10.13 (Electron 26, el ultimo que arranca en 10.13/10.14)', () => {
  const pinned = /-c\.electronVersion=(\d+)\.(\d+)\.(\d+)/.exec(pkg.scripts['dist:mac']);
  assert.ok(pinned, 'dist:mac fija la version de Electron del Mac');
  assert.ok(Number(pinned[1]) <= 26, `Electron ${pinned[1]} ya exige macOS 10.15 (desde la 27); la 26 es el limite para 10.13/10.14`);
  assert.equal(mac.minimumSystemVersion, '10.13.0');
});

test('Mac: firma ad-hoc (sin ella Apple Silicon dice «dañada») y sin «runtime» (no se puede con firma ad-hoc)', () => {
  assert.equal(mac.hardenedRuntime, false);
  assert.equal(mac.sign, './scripts/mac-sign.js');
  assert.equal(typeof require(path.join(ROOT, 'scripts', 'mac-sign.js')), 'function');
});

test('Mac: el ffmpeg va POR arquitectura y sus licencias aparte e IGUALES en las dos (si no, la fusion universal falla)', () => {
  const [binary, ...licenses] = mac.extraResources;
  assert.equal(binary.from, 'vendor/ffmpeg/darwin-${arch}');
  assert.deepEqual(binary.filter, ['ffmpeg'], 'solo el binario: las licencias de x64 y arm64 son archivos distintos');
  const sources = licenses.map((entry) => entry.from).sort();
  assert.deepEqual(sources, ['vendor/ffmpeg/darwin-arm64', 'vendor/ffmpeg/darwin-x64'], 'las licencias de AMBOS viajan en los dos');
  for (const entry of licenses) assert.ok(!entry.from.includes('${arch}'), 'no dependen de la arquitectura');
});

test('Mac: las librerias nativas de las dos arquitecturas viajan fuera del .asar y no hay binarios de otros sistemas', () => {
  assert.ok(pkg.build.asarUnpack.some((glob) => glob.includes('@img')));
  const files = mac.files.join('\n');
  assert.match(files, /!\*\*\/node_modules\/@img\/sharp-linux\*/);
  assert.match(files, /!\*\*\/node_modules\/@img\/sharp-win32\*/);
  assert.doesNotMatch(files, /sharp-darwin/, 'las dos variantes de Mac SI entran');
});

test('Mac: predist prepara las dos arquitecturas de sharp y de ffmpeg', () => {
  const predist = pkg.scripts['predist:mac'];
  for (const text of ['--cpu=x64 sharp', '--cpu=arm64 sharp', 'prepare-ffmpeg.js darwin x64', 'prepare-ffmpeg.js darwin arm64']) {
    assert.ok(predist.includes(text), `falta: ${text}`);
  }
});

test('el flujo de GitHub genera el .dmg, sin .zip, y lo prueba en Macs reales (Intel y Apple Silicon)', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
  assert.match(workflow, /macos-/);
  assert.match(workflow, /dist\/\*\.dmg/);
  assert.doesNotMatch(workflow, /path:[^\n]*\.zip/, 'no se sube ningun .zip de Mac');
  assert.match(workflow, /macos-\d+-intel|macos-13/, 'prueba tambien en un Mac Intel');
  assert.match(workflow, /macos-latest/, 'y en uno Apple Silicon');
});

test('la firma ad-hoc se pide con las opciones correctas y un certificado real se respeta', async () => {
  const Module = require('module');
  const sign = require(path.join(ROOT, 'scripts', 'mac-sign.js'));
  const entry = require.resolve('@electron/osx-sign', { paths: [require.resolve('app-builder-lib')] });
  const calls = [];
  const original = require.cache[entry];
  require.cache[entry] = { id: entry, filename: entry, loaded: true, exports: { signAsync: async (options) => { calls.push(options); } }, children: [], paths: [] };
  try {
    const base = { app: '/x/Compacta.app', optionsForFile: () => ({ hardenedRuntime: true, entitlements: 'e.plist' }), platform: 'darwin' };
    await sign({ ...base, identity: undefined });
    assert.equal(calls[0].identity, '-', 'sin certificado: ad-hoc');
    assert.equal(calls[0].identityValidation, false);
    const perFile = calls[0].optionsForFile('/x/Compacta.app/Contents/MacOS/Compacta');
    assert.equal(perFile.timestamp, 'none');
    assert.equal(perFile.hardenedRuntime, false);
    assert.equal(perFile.entitlements, 'e.plist', 'lo demas de la configuracion se conserva');
    await sign({ ...base, identity: 'Developer ID Application: Alguien' });
    assert.equal(calls[1].identity, 'Developer ID Application: Alguien', 'con certificado real: sin tocar');
    assert.equal(calls[1].optionsForFile, base.optionsForFile);
  } finally {
    if (original) require.cache[entry] = original; else delete require.cache[entry];
    void Module;
  }
});

test('los scripts de empaquetado funcionan en un servidor de CI: sin enlaces duros (Mac) y sin publicar solo (Mac y Windows)', () => {
  // En CI electron-builder usa enlaces duros y la copia de heic-worker.js / heic-color.js (desempaquetados) choca con EEXIST;
  // y por estar en CI intenta publicar y exige GH_TOKEN. Los dos fallos salieron en GitHub, no en local.
  assert.match(pkg.scripts['dist:mac'], /USE_HARD_LINKS=false/);
  assert.match(pkg.scripts['dist:mac'], /--publish never/);
  assert.match(pkg.scripts['dist:win'], /--publish never/);
});
