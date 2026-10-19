'use strict';

/**
 * Arranca la app EMPAQUETADA de verdad -- el `app.asar` que sale de
 * `electron-builder`, no el codigo fuente -- y comprueba que la ventana
 * carga sin que el proceso principal lance una excepcion.
 *
 * Por que existe: la 1.0.6 funcionaba perfecto en todas las pruebas (que
 * corren sobre el codigo fuente sin empaquetar) y aun asi la app instalada
 * no arrancaba -- `electron-builder` quita los campos "build", "scripts" y
 * "devDependencies" de package.json al empaquetar, y el codigo leia
 * `require('../../package.json').build.appId` pensando que iba a estar ahi
 * siempre. Ninguna prueba anterior podia detectar esto porque ninguna
 * llegaba a ejecutar el .asar real. Esta si. Ver DOCUMENTACION-PROYECTO.md
 * seccion 7.12 para el historial completo.
 *
 * Requiere haber construido antes un target Linux "dir" (rapido, sin
 * necesidad de wine ni de un instalador):
 *   npm run build:linux-dir
 * y despues:
 *   xvfb-run -a npm run test:packaged -- --no-sandbox
 *
 * Si no existe el build, la prueba lo dice claramente y no hace nada mas
 * (no intenta construirlo ella misma: eso puede tardar varios minutos y no
 * tiene sentido pagar ese coste en cada `npm test`).
 *
 * IMPORTANTE sobre el orden: el .asar real (igual que el codigo fuente)
 * registra esquemas de protocolo y crea su ventana en su PROPIO
 * `app.whenReady().then(...)` interno -- por eso aqui se hace `require()`
 * ANTES de esperar a que la app este lista, nunca dentro de un
 * `.then()` propio: si no, `protocol.registerSchemesAsPrivileged` truena
 * con "should be called before app is ready" (un fallo del arnes de
 * pruebas, no de la app -- ya paso una vez al escribir esta prueba).
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const ASAR_PATH = path.join(__dirname, '..', 'dist', 'linux-unpacked', 'resources', 'app.asar');

if (!fs.existsSync(ASAR_PATH)) {
  console.log(
    `\nSIN BUILD: no existe ${ASAR_PATH}.\n` +
    'Genera primero un build Linux (rapido, no hace falta wine):\n' +
    '  npm run build:linux-dir\n' +
    'y vuelve a correr esta prueba.\n'
  );
  process.exit(0);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compacta-packaged-'));
app.setPath('userData', path.join(tmpRoot, 'userData'));
app.setPath('documents', path.join(tmpRoot, 'Documents'));

const uncaught = [];
process.on('uncaughtException', (err) => uncaught.push(err));

let loadError = null;
try {
  // Esto es exactamente lo que hace el instalador real: cargar
  // src/main/index.js DESDE DENTRO del .asar, con su package.json
  // recortado y todo -- ni una linea de codigo fuente sin empaquetar.
  require(path.join(ASAR_PATH, 'src', 'main', 'index.js'));
} catch (err) {
  loadError = err;
}

function fail(message) {
  console.error(`\nFAIL  ${message}\n`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  app.exit(1);
}

function pass(message) {
  console.log(`\nPASS  ${message}\n`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  app.exit(0);
}

async function main() {
  if (loadError) {
    fail(`el proceso principal lanzo una excepcion nada mas cargar el .asar empaquetado: ${loadError.stack || loadError}`);
    return;
  }

  const deadline = Date.now() + 20000;
  while (BrowserWindow.getAllWindows().length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (uncaught.length > 0) break;
  }

  if (uncaught.length > 0) {
    fail(`el proceso principal tuvo ${uncaught.length} excepcion(es) sin capturar al arrancar:\n${uncaught.map((e) => e.stack || e).join('\n---\n')}`);
    return;
  }
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    fail('la app empaquetada no llego a crear ninguna ventana');
    return;
  }

  const loadDeadline = Date.now() + 15000;
  while (win.webContents.isLoading() && Date.now() < loadDeadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  const ready = await win.webContents
    .executeJavaScript('!!(window.api && window.QueueView && document.getElementById("settingsBtn"))')
    .catch(() => false);

  if (uncaught.length > 0) {
    fail(`el proceso principal tuvo ${uncaught.length} excepcion(es) sin capturar:\n${uncaught.map((e) => e.stack || e).join('\n---\n')}`);
    return;
  }
  if (!ready) {
    fail('la ventana cargo pero la app no parece haber arrancado bien (falta window.api, QueueView o el boton de ajustes)');
    return;
  }

  // Lo que se instala es el .asar, no el codigo fuente: aqui se comprueba que
  // DENTRO del paquete funcionan las tres piezas externas -- el extractor de
  // ZIP (yauzl), el tar del sistema (RAR/7z/tar) y ffmpeg (video) -- por el
  // mismo camino que usa la interfaz, y que ffmpeg llega a COMPRIMIR de verdad.
  const { makeZip } = require('./helpers/make-zip');
  const { makeVideo } = require('./helpers/make-video');
  const { makeArchive, TOOLS } = require('./helpers/make-archive');
  const tinyJpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
  const srcDir = path.join(tmpRoot, 'src');
  fs.mkdirSync(path.join(srcDir, 'Carpeta'), { recursive: true });
  // Cada archivo lleva unos bytes finales distintos (un JPEG ignora lo que va tras su fin):
  // si fueran identicos, "Omitir duplicados" (activado por defecto) los descartaria.
  const distinct = (n) => Buffer.concat([tinyJpeg, Buffer.from(`compacta-${n}`)]);
  fs.writeFileSync(path.join(srcDir, 'Carpeta', 'b.jpg'), distinct(1));
  fs.writeFileSync(path.join(srcDir, 'Paquete.zip'), makeZip([{ name: 'a.jpg', data: distinct(2) }, { name: 'dir/c.jpg', data: distinct(3), deflate: true }]));
  const videoFolder = path.join(srcDir, 'ParaRar');
  fs.mkdirSync(videoFolder, { recursive: true });
  makeVideo(path.join(videoFolder, 'clip.mp4'), { seconds: 4, size: '640x360' });
  const importPaths = [path.join(srcDir, 'Paquete.zip'), path.join(srcDir, 'Carpeta')];
  let expected = 3;
  let videosExpected = 0;
  if (TOOLS.rar && makeArchive('rar', videoFolder, path.join(srcDir, 'Video.rar'))) {
    importPaths.push(path.join(srcDir, 'Video.rar'));
    expected += 1;
    videosExpected += 1;
  }
  const direct = path.join(srcDir, 'Directo.mov');
  makeVideo(direct, { seconds: 4, size: '640x360' });
  importPaths.push(direct);
  expected += 1;
  videosExpected += 1;
  // Audio (1.0.11): un WAV y un .caf (Mac) deben salir como MP3 desde dentro del paquete (ffmpeg empaquetado).
  const { makeAudio } = require('./helpers/make-audio');
  const audioFiles = [['Sermon.wav', ['-c:a', 'pcm_s16le']], ['Mac.caf', ['-c:a', 'pcm_s16le']]].map(([name, codecArgs], i) => {
    const file = path.join(srcDir, name);
    makeAudio(file, { codecArgs, seconds: 3 + i });
    return file;
  });
  // 1.0.12: una predicacion en estereo duplicado debe salir en mono (analisis de canales + prueba de peso desde el .asar).
  const sermon = path.join(srcDir, 'Predicacion.mp3');
  makeAudio(sermon, { codecArgs: ['-c:a', 'libmp3lame', '-b:a', '192k'], seconds: 6, dualMono: true });
  audioFiles.push(sermon);
  importPaths.push(...audioFiles);
  expected += audioFiles.length;
  // 1.1.0: una foto HEIC (iPhone) se decodifica en un hilo con libheif (WebAssembly) que vive desempaquetado
  // fuera del .asar: si el empaquetado perdiera el hilo o el .wasm, aqui se vería. Pesada (calidad 100) para que
  // convertirla a JPEG la aligere y salga como .jpg (si no, se dejaria como esta y no se probaria la conversion).
  const { makeHeic, HEIC_AVAILABLE } = require('./helpers/make-heic');
  const heicFile = path.join(srcDir, 'Ruido.heic');
  const heicMade = HEIC_AVAILABLE && makeHeic(heicFile, { width: 640, height: 480, kind: 'noise', quality: 100 });
  if (heicMade) {
    importPaths.push(heicFile);
    expected += 1;
  }

  const result = await win.webContents.executeJavaScript(`window.api.importFiles(${JSON.stringify(importPaths)})`).catch((err) => ({ error: String(err) }));
  if (result.error || result.importedCount !== expected || (result.failedArchives || []).length !== 0) {
    fail(`importar a traves del paquete fallo (esperaba ${expected}): ${JSON.stringify(result)}`);
    return;
  }

  // Espera a que TODO termine: los videos solo acaban bien si el ffmpeg
  // empaquetado (desempaquetado de app.asar) se pudo ejecutar.
  const outputDir = path.join(tmpRoot, 'Documents', 'Compacta', 'output');
  const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
  const processingDeadline = Date.now() + 60000;
  while (Date.now() < processingDeadline && walk(outputDir).filter((f) => !f.includes('.tmp-')).length < expected) await new Promise((r) => setTimeout(r, 300));
  const outputs = walk(outputDir).filter((f) => !f.includes('.tmp-'));
  const videoOutputs = outputs.filter((f) => /\.mp4$/i.test(f));
  if (outputs.length !== expected || videoOutputs.length !== videosExpected) {
    fail(`el paquete no proceso todo: ${outputs.length}/${expected} salidas, ${videoOutputs.length}/${videosExpected} videos. Salidas: ${outputs.map((f) => path.relative(outputDir, f)).join(', ')}`);
    return;
  }
  const mp3Outputs = outputs.filter((f) => /\.mp3$/i.test(f));
  if (mp3Outputs.length !== audioFiles.length) {
    fail(`el paquete no comprimio los audios: ${mp3Outputs.length}/${audioFiles.length} MP3. Salidas: ${outputs.map((f) => path.relative(outputDir, f)).join(', ')}`);
    return;
  }
  const monoOut = mp3Outputs.find((f) => /Predicacion\.mp3$/i.test(f));
  if (!monoOut || fs.statSync(monoOut).size > fs.statSync(sermon).size * 0.6) {
    fail(`el paquete no guardo en mono la predicacion en estereo duplicado: ${monoOut ? `${fs.statSync(sermon).size} -> ${fs.statSync(monoOut).size}` : 'no hay salida'}`);
    return;
  }
  if (heicMade) {
    const heicOut = outputs.find((f) => /Ruido\.jpg$/i.test(f));
    const meta = heicOut ? await require('sharp')(heicOut).metadata().catch(() => null) : null;
    if (!meta || meta.format !== 'jpeg' || meta.width !== 640 || meta.height !== 480) {
      fail(`el paquete no convirtio la foto HEIC a JPG (hilo/WebAssembly dentro del .asar): ${heicOut ? JSON.stringify(meta) : 'no hay Ruido.jpg. Salidas: ' + outputs.map((f) => path.relative(outputDir, f)).join(', ')}`);
      return;
    }
  }
  const rowsWithError = await win.webContents.executeJavaScript('document.querySelectorAll(".queue-item--error").length');
  if (rowsWithError !== 0) {
    fail(`${rowsWithError} fila(s) terminaron en error dentro de la app empaquetada`);
    return;
  }

  pass(`la app empaquetada (.asar real) arranca, descomprime ZIP${videosExpected > 1 ? '/RAR' : ''} y comprime ${videosExpected} video(s) y ${audioFiles.length} audio(s) con su ffmpeg${heicMade ? ' y decodifica una foto HEIC (hilo + WebAssembly desempaquetados)' : ''}`);
}

app.whenReady().then(main);
