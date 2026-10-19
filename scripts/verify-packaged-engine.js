'use strict';

/**
 * Prueba de punta a punta del programa YA EMPAQUETADO: usa el Electron, el `app.asar`, las librerias nativas
 * (`sharp`, libvips, libheif) y el ffmpeg QUE VIAJAN dentro de la app, no los del repositorio. Comprime una foto de
 * verdad (JPG, y HEIC si el sistema sabe fabricar uno), un video y un audio, y comprueba que lo que sale se abre.
 *
 * Es lo que se ejecuta en GitHub sobre Macs reales (Intel y Apple Silicon) con el .dmg recien construido: una
 * comprobacion que desde Linux no se puede hacer (ver DOCUMENTACION 7.23).
 *
 * Uso (la app se lanza a si misma como Node, sin abrir ventana):
 *   macOS:  ELECTRON_RUN_AS_NODE=1 "Compacta.app/Contents/MacOS/Compacta" scripts/verify-packaged-engine.js "Compacta.app/Contents/Resources"
 *   Linux:  ELECTRON_RUN_AS_NODE=1 dist/linux-unpacked/compacta scripts/verify-packaged-engine.js dist/linux-unpacked/resources
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const resources = path.resolve(process.argv[2] || '');
const asarRoot = path.join(resources, 'app.asar');
if (!process.argv[2] || !fs.existsSync(asarRoot)) {
  console.error(`Uso: ... verify-packaged-engine.js <carpeta Resources de la app>\n(no se encuentra ${asarRoot})`);
  process.exit(2);
}

const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const ffmpeg = path.join(resources, 'ffmpeg', exe);
process.env.COMPACTA_FFMPEG_PATH = ffmpeg; // el ffmpeg que viaja en la app, no otro
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compacta-verify-'));
process.env.COMPACTA_TEST_BASE_DIR = path.join(tmp, 'base');

const load = createRequire(path.join(asarRoot, 'package.json'));
const results = [];

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}${detail ? ` -- ${detail}` : ''} (${Date.now() - started} ms)`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name}\n        -> ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${args.slice(0, 4).join(' ')}... termino con ${result.status}: ${(result.stderr || '').trim().split('\n').pop()}`);
  return result;
}

/** El archivo se decodifica entero sin errores (si esta cortado o roto, ffmpeg falla). */
function assertDecodes(file) {
  assert(fs.existsSync(file), `no existe ${file}`);
  run(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-f', 'null', '-']);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  console.log(`Electron ${process.versions.electron || '(sin Electron)'} / Node ${process.versions.node} / ${process.platform}-${process.arch} / ${os.release()}`);
  console.log(`Paquete: ${resources}\n`);

  let sharp;
  await check('sharp (la libreria nativa que viaja en la app) se carga y trae libvips', async () => {
    sharp = load('sharp');
    return `sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}`;
  });

  const photo = path.join(tmp, 'foto.jpg');
  await check('se fabrica una foto de prueba (1600x1200, con ruido para que haya que comprimir)', async () => {
    const width = 1600, height = 1200;
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + ((i >> 5) & 0xff) * 3) & 0xff;
    await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 97 }).toFile(photo);
    return `${(fs.statSync(photo).size / 1024).toFixed(0)} KB`;
  });

  await check('foto JPG: la compresion real de Compacta reduce el peso y el resultado se abre', async () => {
    const { optimizeImage } = load(path.join(asarRoot, 'src', 'main', 'processor', 'raster-optimizer.js'));
    const output = path.join(tmp, 'out', 'foto.jpg');
    const report = await optimizeImage(photo, output, { quality: 90, aggressive: false });
    assert(fs.existsSync(report.output), 'no se creo la salida');
    assert(fs.statSync(report.output).size < fs.statSync(photo).size, 'no ahorro nada');
    const meta = await sharp(report.output).metadata();
    assert(meta.width === 1600 && meta.height === 1200, 'las dimensiones cambiaron');
    return `${(fs.statSync(photo).size / 1024).toFixed(0)} KB -> ${(fs.statSync(report.output).size / 1024).toFixed(0)} KB`;
  });

  await check('WebP y AVIF se codifican con el libvips empaquetado', async () => {
    const webp = await sharp(photo).webp({ quality: 80 }).toBuffer();
    const avif = await sharp(photo).resize(400).avif({ quality: 50, effort: 2 }).toBuffer();
    assert(webp.length > 0 && avif.length > 0, 'salida vacia');
    return `webp ${(webp.length / 1024).toFixed(0)} KB, avif ${(avif.length / 1024).toFixed(0)} KB`;
  });

  if (process.platform === 'darwin') {
    await check('foto HEIC (de las que hace un iPhone; la fabrica el propio macOS con sips): se lee con libheif-js y sale una salida valida', async () => {
      const heic = path.join(tmp, 'iphone.heic');
      run('/usr/bin/sips', ['-s', 'format', 'heic', photo, '--out', heic]);
      const { optimizeImage } = load(path.join(asarRoot, 'src', 'main', 'processor', 'raster-optimizer.js'));
      const report = await optimizeImage(heic, path.join(tmp, 'out', 'iphone.heic'), { quality: 90, heicAlwaysJpg: true });
      assert(fs.existsSync(report.output), 'no se creo la salida');
      const meta = await sharp(report.output).metadata();
      assert(meta.format === 'jpeg', `se esperaba JPG y salio ${meta.format}`);
      return `HEIC ${(fs.statSync(heic).size / 1024).toFixed(0)} KB -> JPG ${(fs.statSync(report.output).size / 1024).toFixed(0)} KB`;
    });
  }

  await check('el ffmpeg incluido arranca (la arquitectura y la version de macOS lo dejan ejecutarse)', async () => {
    const { stdout } = run(ffmpeg, ['-hide_banner', '-version']);
    return stdout.split('\n')[0];
  });

  await check('video: se comprime con el ffmpeg incluido y el resultado se reproduce', async () => {
    const clip = path.join(tmp, 'clip.mp4');
    run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '12', '-c:a', 'aac', clip]);
    const { optimizeVideo } = load(path.join(asarRoot, 'src', 'main', 'processor', 'video-optimizer.js'));
    let progress = 0;
    const report = await optimizeVideo(clip, path.join(tmp, 'out', 'clip.mp4'), { quality: 90 }, (p) => { progress = Math.max(progress, p); });
    assertDecodes(report.output);
    assert(fs.statSync(report.output).size < fs.statSync(clip).size, 'no ahorro nada');
    return `${(fs.statSync(clip).size / 1024).toFixed(0)} KB -> ${(fs.statSync(report.output).size / 1024).toFixed(0)} KB, progreso maximo ${(progress * 100).toFixed(0)} %`;
  });

  await check('audio: un WAV se comprime y el resultado se reproduce', async () => {
    const wav = path.join(tmp, 'voz.wav');
    run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=5', '-ac', '2', wav]);
    const { optimizeAudio } = load(path.join(asarRoot, 'src', 'main', 'processor', 'audio-optimizer.js'));
    const report = await optimizeAudio(wav, path.join(tmp, 'out', 'voz.mp3'), { quality: 90 });
    assertDecodes(report.output);
    assert(fs.statSync(report.output).size < fs.statSync(wav).size, 'no ahorro nada');
    return `${(fs.statSync(wav).size / 1024).toFixed(0)} KB -> ${(fs.statSync(report.output).size / 1024).toFixed(0)} KB`;
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('ERROR FATAL:', err);
  process.exit(1);
});
