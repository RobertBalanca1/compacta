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

test('Mac: cada variante es UN solo .dmg universal (Intel + Apple Silicon), sin .zip ni uno por arquitectura', () => {
  assert.equal(mac.target.length, 1, 'un solo target');
  assert.equal(mac.target[0].target, 'dmg');
  assert.deepEqual(mac.target[0].arch, ['universal'], 'Intel y Apple Silicon juntos');
  for (const script of ['dist:mac', 'dist:mac-legacy']) {
    assert.match(pkg.scripts[script], /--universal/, script);
    assert.doesNotMatch(pkg.scripts[script], /--x64|--arm64/, script);
  }
  assert.match(mac.artifactName, /Mac\.\$\{ext\}$/, 'el moderno: Compacta-X.Y.Z-Mac.dmg');
  assert.match(pkg.scripts['dist:mac-legacy'], /Compacta-\$\{version\}-Mac-antiguo\.\$\{ext\}/, 'el antiguo se distingue en el NOMBRE');
});

test('Mac MODERNO: Electron del package.json (el mismo que Windows) y macOS 13 como minimo (lo que exige Electron 44)', () => {
  assert.doesNotMatch(pkg.scripts['dist:mac'], /electronVersion/, 'sin fijar: usa el mismo Electron que Windows');
  assert.equal(mac.minimumSystemVersion, '13.0.0');
  assert.ok(Number(/\d+/.exec(pkg.devDependencies.electron)[0]) >= 38, 'Electron actual (desde la 38 se exige macOS 12 o mas)');
});

test('Mac ANTIGUO: Electron 26 (el ultimo que arranca en macOS 10.13/10.14) y macOS 10.13 como minimo', () => {
  const pinned = /-c\.electronVersion=(\d+)\.(\d+)\.(\d+)/.exec(pkg.scripts['dist:mac-legacy']);
  assert.ok(pinned, 'dist:mac-legacy fija la version de Electron');
  assert.ok(Number(pinned[1]) <= 26, `Electron ${pinned[1]} ya exige macOS 10.15 (desde la 27); la 26 es el limite para 10.13/10.14`);
  assert.match(pkg.scripts['dist:mac-legacy'], /-c\.mac\.minimumSystemVersion=10\.13\.0/);
});

test('sharp: el moderno (y Windows) usan la 0.35 (sin vulnerabilidades conocidas); el antiguo la 0.33.5 (la 0.35 exige macOS 10.15 y Node 20)', () => {
  assert.equal(pkg.dependencies.sharp, '>=0.33.5 <0.36.0', 'el rango admite las dos, asi package.json es coherente con las dos instalaciones');
  assert.match(pkg.scripts['predist:mac'], /sharp@\^0\.35/);
  assert.match(pkg.scripts['predist:win'], /sharp@\^0\.35/);
  assert.match(pkg.scripts['predist:mac-legacy'], /--cpu=x64 sharp@0\.33\.5/);
  assert.match(pkg.scripts['predist:mac-legacy'], /--cpu=arm64 sharp@0\.33\.5/);
});

test('Mac: firma ad-hoc pedida con identity "-" (sin firma, Apple Silicon dice «dañada») y sin «runtime» (no se puede con firma ad-hoc)', () => {
  // electron-builder 26 NO llama a ninguna firma si no encuentra certificado (en la 25 si llamaba a una funcion propia): la unica forma de
  // firmar gratis es identity "-". Sin esto el .app salia SIN firma y las pruebas de GitHub fallaron en el paso «Firma».
  assert.equal(mac.identity, '-');
  assert.equal(mac.timestamp, 'none', 'el sello de hora de Apple necesita red y no tiene sentido en una firma ad-hoc');
  assert.equal(mac.hardenedRuntime, false, 'con «runtime» macOS solo carga librerias del MISMO equipo; una firma ad-hoc no tiene equipo');
  assert.equal(mac.sign, undefined, 'ya no hace falta una funcion de firma propia');
  assert.ok(!fs.existsSync(path.join(ROOT, 'scripts', 'mac-sign.js')));
});

test('Mac: el ffmpeg va POR arquitectura y sus licencias aparte e IGUALES en las dos (si no, la fusion universal falla)', () => {
  const binary = mac.extraResources.find((entry) => entry.to === 'ffmpeg');
  const licenses = mac.extraResources.filter((entry) => String(entry.to).startsWith('ffmpeg/licenses/'));
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

test('Mac: los dos predist preparan las dos arquitecturas de sharp y de ffmpeg', () => {
  for (const name of ['predist:mac', 'predist:mac-legacy']) {
    for (const text of ['--cpu=x64 sharp', '--cpu=arm64 sharp', 'prepare-ffmpeg.js darwin x64', 'prepare-ffmpeg.js darwin arm64']) {
      assert.ok(pkg.scripts[name].includes(text), `${name}: falta ${text}`);
    }
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

test('el .dmg se construye en un Mac Intel (HFS+, legible en macOS 10.13/10.14) y se comprueba su formato', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
  const job = workflow.slice(workflow.indexOf('build-mac:'), workflow.indexOf('verify-mac:'));
  assert.match(job, /runs-on:\s*macos-\d+-intel/, 'en Apple Silicon electron-builder fabrica un .dmg APFS');
  assert.doesNotMatch(job, /runs-on:\s*macos-latest/);
  assert.match(workflow, /File System Personality[\s\S]*HFS/, 'el flujo comprueba que el volumen es HFS+');
});

test('los scripts de empaquetado funcionan en un servidor de CI: sin enlaces duros (Mac) y sin publicar solo (Mac y Windows)', () => {
  // En CI electron-builder usa enlaces duros y la copia de heic-worker.js / heic-color.js (desempaquetados) choca con EEXIST;
  // y por estar en CI intenta publicar y exige GH_TOKEN. Los dos fallos salieron en GitHub, no en local.
  assert.match(pkg.scripts['dist:mac'], /USE_HARD_LINKS=false/);
  assert.match(pkg.scripts['dist:mac'], /--publish never/);
  assert.match(pkg.scripts['dist:win'], /--publish never/);
});

test('el .dmg se pide en HFS+ de forma explicita y las librerias de sharp se declaran para la fusion universal', () => {
  // electron-builder 26 avisa de que el formato por defecto pasara a APFS en la proxima version mayor (APFS: arriesgado en macOS 10.13/10.14).
  assert.equal(pkg.build.dmg.filesystem, 'HFS+');
  // @electron/universal 2.x exige que todo binario IGUAL en los dos paquetes (las librerias de sharp de las dos arquitecturas) se declare;
  // sin esto la fusion falla con «same in both x64 and arm64 builds and not covered by the x64ArchFiles rule».
  assert.equal(mac.x64ArchFiles, 'Contents/Resources/app.asar.unpacked/node_modules/@img/**');
});

test('los flujos de GitHub usan acciones que corren sobre Node 24 (las anteriores dan el aviso «Node.js 20 is deprecated»)', () => {
  const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
  for (const [, name, major] of text.matchAll(/uses:\s*(actions\/[a-z-]+)@v(\d+)/g)) {
    assert.ok(Number(major) >= 6, `${name}@v${major} corre sobre Node 20`);
  }
  assert.doesNotMatch(text, /softprops\/action-gh-release@v[12]\b/);
});

test('los avisos de permisos de macOS (Documentos, Escritorio, Descargas, discos externos y de red) existen y estan en los 6 idiomas', () => {
  const keys = ['NSDocumentsFolderUsageDescription', 'NSDesktopFolderUsageDescription', 'NSDownloadsFolderUsageDescription', 'NSRemovableVolumesUsageDescription', 'NSNetworkVolumesUsageDescription'];
  for (const key of keys) assert.ok(String(mac.extendInfo[key] || '').length > 20, `Info.plist: falta ${key}`);
  assert.ok(mac.extraResources.some((entry) => entry.from === 'build/mac-strings' && entry.to === '.'), 'las traducciones viajan en Resources');
  for (const code of require('../src/shared/i18n').CODES) {
    const file = path.join(ROOT, 'build', 'mac-strings', `${code}.lproj`, 'InfoPlist.strings');
    assert.ok(fs.existsSync(file), `falta ${code}.lproj/InfoPlist.strings`);
    const text = fs.readFileSync(file, 'utf8');
    for (const key of keys) assert.match(text, new RegExp(`^"${key}" = ".{20,}";$`, 'm'), `${code}: falta ${key}`);
  }
});

test('el flujo de GitHub construye, prueba y publica LAS DOS variantes de Mac (moderna y antigua)', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
  assert.match(workflow, /script: dist:mac\n/);
  assert.match(workflow, /script: dist:mac-legacy/);
  assert.match(workflow, /artefacto: Compacta-Mac\n/);
  assert.match(workflow, /artefacto: Compacta-Mac-antiguo/);
  assert.match(workflow, /variante: \[moderno, antiguo\]/, 'las dos se prueban');
  assert.match(workflow, /os: \[macos-latest, macos-15-intel\]/, 'en Apple Silicon y en Intel, con ejes limpios (4 pruebas)');
  assert.match(workflow, /'13\.0\.0' \|\| '10\.13\.0'/, 'el minimo de macOS esperado de cada una');
  assert.match(workflow, /pattern: Compacta-\*/, 'el Release lleva las dos y la de Windows');
});

test('el flujo de GitHub tambien ejecuta la herramienta propia sobre el .app (la contrasta con lipo en un Mac real) y el verificador del paquete', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
  assert.match(workflow, /node scripts\/mac-app-tools\.js check "\$APP"/);
  assert.match(workflow, /scripts\/verify-packaged-engine\.js/);
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'mac-app-tools.js')) && fs.existsSync(path.join(ROOT, 'scripts', 'verify-packaged-engine.js')));
});

test('el flujo abre la app de prueba con --disable-gpu (el Mac Intel de GitHub es una VM sin GPU y Electron 44 no inicia la GPU en ella)', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
  assert.match(workflow, /Contents\/MacOS\/Compacta" --disable-gpu/);
  assert.doesNotMatch(workflow, /DIAGNOSTICO TEMPORAL|registro-ventana/, 'sin restos de diagnostico');
});
