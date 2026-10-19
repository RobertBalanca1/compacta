'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { p3ToSrgbInPlace, detectDisplayP3, iccHasP3Primaries } = require('../src/main/processor/heic-color');
const { decodeHeic, shutdownHeicWorker, isHeicPath, looksLikeHeic } = require('../src/main/processor/heic');
const { optimizeImage } = require('../src/main/processor/raster-optimizer');
const { isSupportedImage, mediaKind, candidateOutputFileNames } = require('../src/main/processor/formats');
const { makeHeic, HEIC_AVAILABLE } = require('./helpers/make-heic');

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'compacta-heic-'));
test.after(() => shutdownHeicWorker());

test('.heic y .heif se reconocen como fotos, y su salida puede ser .jpg', () => {
  assert.equal(isSupportedImage('IMG_0001.HEIC'), true);
  assert.equal(mediaKind('a/b/foto.heif'), 'image');
  assert.equal(isHeicPath('x.HeIc'), true);
  assert.equal(isHeicPath('x.jpg'), false);
  assert.ok(candidateOutputFileNames('IMG_1.heic').includes('img_1.jpg'), 'al arrancar no se reencola una foto cuyo JPG ya está hecho');
  assert.ok(candidateOutputFileNames('IMG_1.heic').includes('img_1.heic'), 'ni una que se dejó tal cual');
});

test('color: Display P3 -> sRGB conserva grises, negro y blanco, y coincide con la conversión de libvips (ICC real)', async () => {
  const grays = Buffer.from([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255, 40, 40, 40, 200]);
  const copy = Buffer.from(grays);
  p3ToSrgbInPlace(copy);
  assert.deepEqual([...copy], [...grays], 'un gris sigue siendo gris y el alfa no se toca');

  // Referencia independiente: sRGB -> P3 con el perfil de libvips; mi conversion inversa debe devolver el original.
  const w = 64;
  const h = 64;
  const original = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = (y * w + x) * 3;
    original[i] = 60 + Math.round((x / w) * 130); // colores DENTRO del gamut sRGB (sin saturar al máximo)
    original[i + 1] = 50 + Math.round((y / h) * 140);
    original[i + 2] = 70 + Math.round(((x + y) / (w + h)) * 120);
  }
  const { data } = await sharp(original, { raw: { width: w, height: h, channels: 3 } }).withIccProfile('p3').raw().toBuffer({ resolveWithObject: true });
  const p3Rgba = Buffer.alloc(w * h * 4);
  for (let p = 0; p < w * h; p += 1) { data.copy(p3Rgba, p * 4, p * 3, p * 3 + 3); p3Rgba[p * 4 + 3] = 255; }
  p3ToSrgbInPlace(p3Rgba);
  let worst = 0;
  for (let p = 0; p < w * h; p += 1) for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(p3Rgba[p * 4 + c] - original[p * 3 + c]));
  assert.ok(worst <= 2, `diferencia máxima ${worst}/255 frente al perfil real de libvips`);
});

test('color: se detecta Display P3 por la propiedad nclx (primarias 12) o por el nombre del perfil ICC; lo demás no', () => {
  const box = (type, payload) => Buffer.concat([Buffer.from([0, 0, 0, 8 + payload.length]), Buffer.from(type, 'latin1'), payload]);
  const nclx = (primaries) => box('colr', Buffer.concat([Buffer.from('nclx'), Buffer.from([0, primaries, 0, 13, 0, 6, 0x80])]));
  assert.equal(detectDisplayP3(Buffer.concat([Buffer.alloc(20), nclx(12)])), true);
  assert.equal(detectDisplayP3(Buffer.concat([Buffer.alloc(20), nclx(1)])), false, 'primarias BT.709 = sRGB');
  const icc = (name, utf16) => box('colr', Buffer.concat([Buffer.from('prof'), Buffer.alloc(8), utf16 ? Buffer.from(name, 'utf16le').swap16() : Buffer.from(name, 'latin1'), Buffer.alloc(8)]));
  assert.equal(detectDisplayP3(Buffer.concat([Buffer.alloc(16), icc('Display P3', true)])), true, 'nombre en UTF-16 (lo que escribe el iPhone)');
  assert.equal(detectDisplayP3(Buffer.concat([Buffer.alloc(16), icc('Display P3', false)])), true);
  assert.equal(detectDisplayP3(Buffer.concat([Buffer.alloc(16), icc('sRGB IEC61966-2.1', true)])), false);
  assert.equal(detectDisplayP3(Buffer.alloc(100)), false, 'sin propiedad de color');
  assert.equal(detectDisplayP3(Buffer.from('colr')), false, 'archivo truncado: no revienta');
});

test('REAL: un HEIC se decodifica con sus colores y sus medidas (sin girarse ni cambiar de lado)', { skip: !HEIC_AVAILABLE && 'pillow-heif no está instalado' }, async (t) => {
  const dir = await tmp();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mitades.heic');
  assert.ok(makeHeic(file, { width: 320, height: 200, kind: 'halves', quality: 90 }));
  assert.equal(looksLikeHeic(fs.readFileSync(file)), true);

  const { width, height, rgba } = await decodeHeic(file);
  assert.equal(width, 320);
  assert.equal(height, 200);
  assert.equal(rgba.length, 320 * 200 * 4);
  const at = (x, y) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];
  const [lr, lg, lb] = at(40, 100);
  const [rr, rg, rb] = at(280, 100);
  assert.ok(lr > 180 && lg < 60 && lb < 60, `izquierda debía ser roja: ${at(40, 100)}`);
  assert.ok(rb > 180 && rr < 60 && rg < 60, `derecha debía ser azul: ${at(280, 100)}`);
});

test('REAL: un HEIC que se aligera al pasar a JPEG sale como .jpg (y es una foto válida con las mismas medidas)', { skip: !HEIC_AVAILABLE && 'pillow-heif no está instalado' }, async (t) => {
  const dir = await tmp();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ruido.heic');
  assert.ok(makeHeic(file, { width: 400, height: 300, kind: 'noise', quality: 95 }));
  const report = await optimizeImage(file, path.join(dir, 'out', 'ruido.heic'), { quality: 60 });
  assert.equal(report.skipped, false);
  assert.equal(path.extname(report.output), '.jpg');
  const meta = await sharp(report.output).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.deepEqual([meta.width, meta.height], [400, 300]);
  assert.ok(fs.statSync(report.output).size < fs.statSync(file).size);
});

test('REAL: un HEIC que pesaría MÁS como JPEG se deja tal cual (nunca peor que el original) y se explica', { skip: !HEIC_AVAILABLE && 'pillow-heif no está instalado' }, async (t) => {
  const dir = await tmp();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'suave.heic');
  assert.ok(makeHeic(file, { width: 600, height: 400, kind: 'smooth', quality: 20 }));
  const report = await optimizeImage(file, path.join(dir, 'out', 'suave.heic'), { quality: 100 });
  assert.equal(report.skipped, true);
  assert.equal(report.reason, 'heic-eficiente');
  assert.equal(path.extname(report.output), '.heic');
  assert.deepEqual(fs.readFileSync(report.output), fs.readFileSync(file), 'copia exacta');
});

test('REAL: decodificar NO congela el proceso (el hilo principal sigue respondiendo mientras tanto)', { skip: !HEIC_AVAILABLE && 'pillow-heif no está instalado' }, async (t) => {
  const dir = await tmp();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'grande.heic');
  assert.ok(makeHeic(file, { width: 3000, height: 2000, kind: 'noise', quality: 70 }));
  await decodeHeic(file); // calienta el hilo (carga de WebAssembly) para medir solo la decodificación
  let last = Date.now();
  let worstGap = 0;
  const timer = setInterval(() => { const now = Date.now(); worstGap = Math.max(worstGap, now - last); last = now; }, 10);
  const started = Date.now();
  await decodeHeic(file);
  const took = Date.now() - started;
  clearInterval(timer);
  assert.ok(took > 150, `la prueba solo vale si la decodificación dura algo (duró ${took} ms)`);
  assert.ok(worstGap < Math.max(120, took / 3), `el hilo principal se quedó parado ${worstGap} ms durante una decodificación de ${took} ms`);
});

test('un HEIC dañado o que no lo es falla con un mensaje claro, y el hilo sigue sirviendo después', { skip: !HEIC_AVAILABLE && 'pillow-heif no está instalado' }, async (t) => {
  const dir = await tmp();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const good = path.join(dir, 'bueno.heic');
  assert.ok(makeHeic(good, { width: 200, height: 120, kind: 'halves' }));
  const bytes = fs.readFileSync(good);
  const truncated = path.join(dir, 'cortado.heic');
  fs.writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
  const fake = path.join(dir, 'falso.heic');
  fs.writeFileSync(fake, 'esto no es una foto');

  await assert.rejects(() => decodeHeic(truncated), /HEIC/);
  await assert.rejects(() => decodeHeic(fake), /HEIC/);
  await assert.rejects(() => optimizeImage(fake, path.join(dir, 'out', 'falso.heic'), {}), /HEIC/);
  const ok = await decodeHeic(good);
  assert.equal(ok.width, 200, 'después de los fallos, una foto buena se decodifica sin problema');
});

test('REAL: la vista previa funciona con un HEIC (antes) y su resultado', { skip: !HEIC_AVAILABLE && 'pillow-heif no está instalado' }, async (t) => {
  const { buildPreview } = require('../src/main/preview');
  const dir = await tmp();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ruido.heic');
  assert.ok(makeHeic(file, { width: 400, height: 300, kind: 'noise', quality: 95 }));
  const report = await optimizeImage(file, path.join(dir, 'out', 'ruido.heic'), { quality: 60 });
  const preview = await buildPreview({ kind: 'image', status: 'done', inputPath: file, report });
  assert.match(preview.before.dataUrl, /^data:image\/jpeg;base64,/);
  assert.deepEqual([preview.before.width, preview.before.height], [400, 300]);
  assert.match(preview.after.dataUrl, /^data:image\/jpeg;base64,/);
});

test('REAL: un HEIC que declara Display P3 se convierte a sRGB (colores más vivos, no apagados); sin perfil, se deja como está', { skip: !HEIC_AVAILABLE && 'pillow-heif no está instalado' }, async (t) => {
  const dir = await tmp();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  // Perfil Display P3 REAL: el que libvips incrusta en un JPEG al pedir 'p3'.
  const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).withIccProfile('p3').jpeg().toBuffer();
  const iccPath = path.join(dir, 'p3.icc');
  fs.writeFileSync(iccPath, (await sharp(jpg).metadata()).icc);

  const plain = path.join(dir, 'sin-perfil.heic');
  const p3 = path.join(dir, 'p3.heic');
  assert.ok(makeHeic(plain, { kind: 'halves', quality: 95 }));
  assert.ok(makeHeic(p3, { kind: 'halves', quality: 95, iccPath }));
  const a = await decodeHeic(plain);
  const b = await decodeHeic(p3);
  assert.equal(a.displayP3, false);
  assert.equal(b.displayP3, true);
  const redOf = (d) => d.rgba[(100 * d.width + 40) * 4];
  const greenOf = (d) => d.rgba[(100 * d.width + 40) * 4 + 1];
  assert.ok(redOf(b) > redOf(a) + 8, `el rojo P3 debe ser más intenso en sRGB: ${redOf(a)} -> ${redOf(b)}`);
  assert.ok(greenOf(b) <= greenOf(a), 'y el verde residual no sube');
});

test('color: el perfil se reconoce por sus PRIMARIAS, no por su nombre (P3 con cualquier nombre sí; sRGB y Adobe RGB no)', async () => {
  const iccOf = async (name) => (await sharp(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).withIccProfile(name).jpeg().toBuffer()).metadata()).icc;
  assert.equal(iccHasP3Primaries(await iccOf('p3')), true, 'el perfil «sP3C» de libvips no dice «Display P3» pero lo es');
  assert.equal(iccHasP3Primaries(await iccOf('srgb')), false);
  assert.equal(iccHasP3Primaries(Buffer.alloc(10)), false, 'datos que no son un perfil: no revienta');
});

test('REAL: con «pasar siempre a JPG», un HEIC que pesaría MÁS sale igualmente como .jpg, y la fila lo explica', { skip: !HEIC_AVAILABLE && 'pillow-heif no está instalado' }, async (t) => {
  const dir = await tmp();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'suave.heic');
  assert.ok(makeHeic(file, { width: 600, height: 400, kind: 'smooth', quality: 20 }));
  const report = await optimizeImage(file, path.join(dir, 'out', 'suave.heic'), { quality: 100, heicAlwaysJpg: true });
  assert.equal(report.skipped, false, 'se convierte aunque pese más');
  assert.equal(path.extname(report.output), '.jpg');
  assert.ok(report.newBytes > report.originalBytes, 'en este caso el JPG pesa más (si no, la prueba no prueba nada)');
  assert.equal((await sharp(report.output).metadata()).format, 'jpeg');
  assert.match(report.detail, /JPG/);
  assert.equal(report.savedBytes, 0, 'nunca se cuenta un ahorro que no existe');
});

test('REAL: «pasar siempre a JPG» no cambia nada para fotos que NO son HEIC', async (t) => {
  const dir = await tmp();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const png = path.join(dir, 'a.png');
  await sharp({ create: { width: 80, height: 80, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 30 } } }).png().toFile(png);
  const report = await optimizeImage(png, path.join(dir, 'out', 'a.png'), { quality: 80, heicAlwaysJpg: true });
  assert.equal(path.extname(report.output), '.png');
});
