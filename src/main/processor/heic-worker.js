'use strict';

/**
 * Hilo que decodifica fotos HEIC (ver heic.js). libheif es WebAssembly y decodificar una foto de
 * 12 megapixeles tarda segundos: en el proceso principal congelaria la ventana, la cola y los avisos
 * mientras dura. Aqui trabaja aparte y devuelve los pixeles ya en sRGB.
 */

const { parentPort, workerData } = require('worker_threads');
const { detectDisplayP3, p3ToSrgbInPlace } = require('./heic-color');

let libheif = null;
let ready = null;

function load() {
  if (!ready) {
    libheif = require(workerData.libheifPath);
    // Se espera a `ready` (no se devuelve el propio modulo: tiene `then` y una promesa que lo devolviera
    // se quedaria esperandose a si misma).
    ready = Promise.resolve(libheif.ready).then(() => undefined);
  }
  return ready;
}

parentPort.on('message', async ({ id, buffer, maxPixels }) => {
  let decoder = null;
  let images = [];
  try {
    await load();
    const bytes = new Uint8Array(buffer);
    decoder = new libheif.HeifDecoder();
    images = decoder.decode(bytes);
    if (!images.length) throw Object.assign(new Error('HEIF image not found'), { code: 'no-image' });
    const image = images[0]; // la imagen principal
    const width = image.get_width();
    const height = image.get_height();
    if (width * height > maxPixels) throw Object.assign(new Error(`demasiados pixeles: ${width}x${height}`), { code: 'too-big' });
    // libheif aplica la rotacion/espejo de la foto (irot/imir): sale ya derecha.
    const shown = await new Promise((resolve, reject) => {
      image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (data) => (data ? resolve(data) : reject(new Error('HEIF processing error'))));
    });
    const rgba = Buffer.from(shown.data.buffer, shown.data.byteOffset, shown.data.byteLength);
    const displayP3 = detectDisplayP3(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (displayP3) p3ToSrgbInPlace(rgba);
    parentPort.postMessage({ id, ok: true, width, height, displayP3, rgba: shown.data.buffer }, [shown.data.buffer]);
  } catch (err) {
    parentPort.postMessage({ id, ok: false, code: err && err.code, message: err && err.message ? err.message : String(err) });
  } finally {
    for (const image of images) {
      try { image.free(); } catch { /* ya liberada */ }
    }
    try { if (decoder && decoder.decoder) decoder.decoder.delete(); } catch { /* idem */ }
  }
});
