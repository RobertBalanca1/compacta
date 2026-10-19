'use strict';

/**
 * Deja en vendor/ffmpeg/<plataforma>-<arquitectura>/ el ffmpeg que se va a
 * EMPAQUETAR para esa plataforma, que no siempre es la del equipo que
 * empaqueta (generar el instalador de Windows desde Linux, o los dos .dmg de
 * Mac -Intel y Apple Silicon- desde un solo Mac).
 *
 * Uso: node scripts/prepare-ffmpeg.js [plataforma arquitectura]
 *      node scripts/prepare-ffmpeg.js win32 x64
 *      node scripts/prepare-ffmpeg.js darwin arm64
 *      node scripts/prepare-ffmpeg.js            (la del equipo actual)
 *
 * No descarga nada por su cuenta: usa el instalador del paquete
 * `ffmpeg-static` (dependencia de desarrollo) indicandole la plataforma. Se
 * ejecuta en una copia temporal para no pisar nunca el ffmpeg del propio
 * equipo, y asi los dos binarios de Mac (que se llaman igual) no se mezclan.
 * Si el binario ya esta en vendor/, no hace nada.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;
const exeName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const root = path.join(__dirname, '..');
const target = path.join(root, 'vendor', 'ffmpeg', `${platform}-${arch}`);

if (fs.existsSync(path.join(target, exeName))) {
  console.log(`ffmpeg ${platform}-${arch}: ya esta en vendor/, no se descarga de nuevo.`);
  process.exit(0);
}

const source = path.join(root, 'node_modules', 'ffmpeg-static');
if (!fs.existsSync(path.join(source, 'install.js'))) {
  console.error('Falta el paquete ffmpeg-static: ejecuta "npm install" primero.');
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'compacta-ffmpeg-'));
try {
  fs.cpSync(source, work, { recursive: true });
  // Fuera todo lo que sea de OTRA plataforma (binarios, licencias, lecturas):
  // en vendor/ solo debe quedar el ffmpeg de esta con SU licencia.
  for (const stale of fs.readdirSync(work)) if (/^ffmpeg/.test(stale)) fs.rmSync(path.join(work, stale), { force: true });

  const result = spawnSync(process.execPath, [path.join(work, 'install.js')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      // install.js usa sus dependencias (descarga, barra de progreso): se le
      // indica donde estan, porque se ejecuta desde la copia temporal.
      NODE_PATH: path.join(root, 'node_modules'),
      npm_config_platform: platform,
      npm_config_arch: arch
    }
  });
  if (result.status !== 0 || !fs.existsSync(path.join(work, exeName))) {
    console.error(`No se pudo obtener ffmpeg para ${platform}-${arch}.`);
    process.exit(1);
  }

  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(work)) {
    if (name === exeName || /^ffmpeg.*\.(LICENSE|README)$/.test(name)) fs.copyFileSync(path.join(work, name), path.join(target, name));
  }
  if (platform !== 'win32') fs.chmodSync(path.join(target, exeName), 0o755);
  console.log(`ffmpeg ${platform}-${arch}: listo en ${path.relative(root, target)}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
