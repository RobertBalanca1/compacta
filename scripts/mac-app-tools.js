#!/usr/bin/env node
'use strict';

/**
 * Herramientas para revisar el `.app` de Mac que construye electron-builder, sin necesitar un Mac.
 *
 *   node scripts/mac-app-tools.js check [ruta/Compacta.app]
 *       Lista TODOS los ejecutables y librerias del `.app` (arquitecturas y macOS minimo de cada pieza) y falla si algo
 *       pide mas macOS del que el instalador declara (`LSMinimumSystemVersion`) o si falta la parte Intel o la de
 *       Apple Silicon en el ejecutable o en el ffmpeg. Por defecto revisa dist/mac-universal/Compacta.app.
 *       Solo lee cabeceras (src/main/macho.js): sirve en Linux y en el propio Mac (alli GitHub la compara ademas con `lipo`).
 *
 *   node scripts/mac-app-tools.js merge
 *       Solo en Linux: junta dist/mac-universal-x64-temp y dist/mac-universal-arm64-temp (los dos paquetes que deja
 *       `electron-builder --mac dir --universal` justo antes de fallar, porque @electron/universal solo corre en macOS)
 *       en dist/mac-universal/Compacta.app, con las MISMAS opciones que usa electron-builder. Necesita `lipo`
 *       (en Ubuntu: `apt install llvm` y `ln -s /usr/bin/llvm-lipo-18 /usr/local/bin/lipo`).
 *       Detecta lo que romperia la fusion real (por ejemplo, un archivo de licencia distinto en cada arquitectura).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readMachoSlices } = require('../src/main/macho');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DEFAULT_APP = path.join(DIST, 'mac-universal', 'Compacta.app');
const APPLE_SILICON_FLOOR = '11.0.0'; // el primer macOS que corre en chips Apple
// El ffmpeg de Apple Silicon pide macOS 12; en un Mac con chip Apple y macOS 11 se usa su parte Intel con Rosetta
// (ver `ffmpegLaunch` en src/main/processor/ffmpeg.js), asi que no cuenta como incumplimiento.
const ROSETTA_COVERED = 'Contents/Resources/ffmpeg/ffmpeg';

const toTuple = (version) => String(version).split('.').map((part) => parseInt(part, 10) || 0);

/** ¿`a` es una version mayor que `b`? ('13.0.0' > '10.13.0') */
function isNewer(a, b) {
  const x = toTuple(a);
  const y = toTuple(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] || 0) - (y[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

function plistString(text, key) {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text);
  return match ? match[1] : null;
}

function walkFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkFiles(full, found);
    else if (entry.isFile() && fs.statSync(full).size >= 64) found.push(full);
  }
  return found;
}

/**
 * Revisa un `.app`. Devuelve { declared, executable, binaries: [{ rel, slices }], problems: [], notes: [] }.
 * `problems` vacio = todo en regla.
 */
function inspectApp(appPath) {
  const result = { declared: null, executable: null, binaries: [], problems: [], notes: [] };
  const plistFile = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistFile)) {
    result.problems.push(`No existe ${plistFile}: no es un .app`);
    return result;
  }
  const plist = fs.readFileSync(plistFile, 'utf8');
  result.declared = plistString(plist, 'LSMinimumSystemVersion');
  result.executable = plistString(plist, 'CFBundleExecutable');
  if (!result.declared) result.problems.push('Info.plist no declara LSMinimumSystemVersion (macOS minimo)');

  for (const file of walkFiles(path.join(appPath, 'Contents'))) {
    const slices = readMachoSlices(file);
    if (slices.length) result.binaries.push({ rel: path.relative(appPath, file).split(path.sep).join('/'), slices });
  }

  const requireBoth = (rel, label) => {
    const entry = result.binaries.find((binary) => binary.rel === rel);
    const archs = entry ? entry.slices.map((slice) => slice.arch) : [];
    for (const arch of ['x64', 'arm64']) {
      if (!archs.includes(arch)) result.problems.push(`${label} (${rel}) no lleva la parte ${arch === 'x64' ? 'Intel' : 'Apple Silicon'}`);
    }
  };
  requireBoth(`Contents/MacOS/${result.executable}`, 'El ejecutable');
  requireBoth(ROSETTA_COVERED, 'El ffmpeg');

  if (result.declared) {
    for (const { rel, slices } of result.binaries) {
      for (const { arch, minos } of slices) {
        const required = arch === 'arm64' && isNewer(APPLE_SILICON_FLOOR, result.declared) ? APPLE_SILICON_FLOOR : result.declared;
        if (!minos || !isNewer(minos, required)) continue;
        const text = `${rel} (${arch}) pide macOS ${minos} y el instalador declara ${result.declared}`;
        if (rel === ROSETTA_COVERED && arch === 'arm64') result.notes.push(`${text}: cubierto con Rosetta`);
        else result.problems.push(text);
      }
    }
  }
  return result;
}

function printInspection(appPath, result) {
  console.log(`Revision de ${appPath}`);
  console.log(`macOS minimo declarado: ${result.declared || '(ninguno)'} | ejecutable: ${result.executable || '(?)'}`);
  const groups = new Map();
  for (const { slices } of result.binaries) {
    for (const { arch, minos } of slices) {
      const key = `${arch} ${minos || '?'}`;
      groups.set(key, (groups.get(key) || 0) + 1);
    }
  }
  console.log(`Piezas Mach-O: ${result.binaries.length}. Por arquitectura y macOS minimo:`);
  for (const [key, count] of [...groups].sort()) console.log(`  ${key}: ${count}`);
  for (const note of result.notes) console.log(`NOTA: ${note}`);
  for (const problem of result.problems) console.log(`PROBLEMA: ${problem}`);
  console.log(result.problems.length ? `\n${result.problems.length} problema(s).` : '\nTodo en regla.');
}

/** Solo Linux: la fusion Intel + Apple Silicon que electron-builder hace en macOS. */
async function mergeUniversal({ x64Dir, arm64Dir, outDir, x64ArchFiles }) {
  if (spawnSync('lipo', ['-info', '/dev/null']).error) {
    throw new Error('No hay `lipo` en el PATH (en Ubuntu: apt install llvm && ln -s /usr/bin/llvm-lipo-18 /usr/local/bin/lipo)');
  }
  // @electron/universal se niega a correr fuera de macOS; con `lipo` disponible la fusion funciona igual.
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const entry = require.resolve('@electron/universal', { paths: [require.resolve('app-builder-lib')] });
  const { makeUniversalApp } = require(entry);
  await makeUniversalApp({ x64AppPath: x64Dir, arm64AppPath: arm64Dir, outAppPath: outDir, force: true, mergeASARs: true, x64ArchFiles });
}

async function main(argv) {
  const [command, argument] = argv;
  if (command === 'check') {
    const appPath = path.resolve(argument || DEFAULT_APP);
    const result = inspectApp(appPath);
    printInspection(appPath, result);
    return result.problems.length ? 1 : 0;
  }
  if (command === 'merge') {
    const pkg = require('../package.json');
    await mergeUniversal({
      x64Dir: path.join(DIST, 'mac-universal-x64-temp', 'Compacta.app'),
      arm64Dir: path.join(DIST, 'mac-universal-arm64-temp', 'Compacta.app'),
      outDir: DEFAULT_APP,
      x64ArchFiles: pkg.build.mac.x64ArchFiles
    });
    console.log(`Fusion correcta: ${DEFAULT_APP}`);
    return 0;
  }
  console.error('Uso: node scripts/mac-app-tools.js check [ruta/Compacta.app]  |  node scripts/mac-app-tools.js merge');
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { inspectApp, isNewer };
