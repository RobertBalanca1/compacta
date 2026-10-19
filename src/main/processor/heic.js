'use strict';

/**
 * Fotos HEIC / HEIF (las del iPhone). `sharp` no las decodifica (le falta el decodificador HEVC, que va
 * aparte por patentes) y el ffmpeg de Windows de 1.0.x tampoco las lee, asi que se decodifican con
 * libheif compilado a WebAssembly (`libheif-js`), SIN depender de ffmpeg ni de nada del sistema: igual en
 * Windows, Mac y Linux. Lo decodificado son pixeles en bruto (RGBA, ya en sRGB) que se entregan a sharp.
 *
 * - La decodificacion va en un HILO aparte (heic-worker.js): en el principal congelaria la app.
 * - Un solo hilo, reutilizado y retirado tras un rato sin uso (la memoria de WebAssembly no se devuelve
 *   sola). Las decodificaciones se hacen de una en una; el resto del trabajo (comprimir) sigue en paralelo.
 * - Limite de tamano: una foto de mas de MAX_PIXELS se rechaza antes de reservar memoria.
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { t } = require('../../shared/i18n');
const { getSharp } = require('../sharp-lazy');

const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);
const MAX_PIXELS = 100 * 1000 * 1000; // 100 MP = ~400 MB de pixeles RGBA: mas que cualquier telefono actual
const IDLE_MS = 20 * 1000; // sin decodificar nada durante este tiempo, el hilo se retira
const CACHE_MS = 60 * 1000; // la ultima foto decodificada se recuerda un rato (vista previa y detalle la piden varias veces)

const isHeicPath = (filePath) => HEIC_EXTENSIONS.has(path.extname(String(filePath)).toLowerCase());

/** El archivo empieza como un contenedor HEIF de imagen ("ftyp" + una marca conocida). */
function looksLikeHeic(buffer) {
  return buffer.length >= 12 && buffer.toString('latin1', 4, 8) === 'ftyp' && HEIC_BRANDS.has(buffer.toString('latin1', 8, 12).trim().replace('\0', ' ').trim());
}

/** Dentro de la app empaquetada, lo que va "desempaquetado" (ver asarUnpack) vive en app.asar.unpacked. */
function realPath(file) {
  const unpacked = file.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return unpacked !== file && fsSync.existsSync(unpacked) ? unpacked : file;
}

let worker = null;
let nextId = 1;
const pending = new Map();
let idleTimer = null;

function dropWorker(error) {
  const dead = worker;
  worker = null;
  clearTimeout(idleTimer);
  for (const { reject } of pending.values()) reject(error || new Error('heic worker stopped'));
  pending.clear();
  if (dead) dead.terminate().catch(() => {});
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(realPath(path.join(__dirname, 'heic-worker.js')), {
    workerData: { libheifPath: realPath(require.resolve('libheif-js/wasm-bundle')) }
  });
  worker.unref(); // no impide que la app se cierre
  worker.on('message', (message) => {
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    if (message.ok) job.resolve(message);
    else job.reject(Object.assign(new Error(message.message), { code: message.code }));
    if (pending.size === 0) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => dropWorker(), IDLE_MS);
      idleTimer.unref();
    }
  });
  worker.on('error', (err) => dropWorker(err));
  worker.on('exit', () => dropWorker());
  return worker;
}

/** Decodifica la foto: { width, height, rgba (Buffer, sRGB), displayP3 }. */
async function decodeHeic(filePath) {
  const file = await fs.readFile(filePath);
  if (!looksLikeHeic(file)) throw new Error(t('media.badHeic'));
  const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength); // copia propia: se transfiere al hilo
  clearTimeout(idleTimer);
  try {
    const message = await new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        getWorker().postMessage({ id, buffer: bytes, maxPixels: MAX_PIXELS }, [bytes]);
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
    return { width: message.width, height: message.height, displayP3: message.displayP3, rgba: Buffer.from(message.rgba) };
  } catch (err) {
    console.error('[heic] no se pudo decodificar:', err && err.message);
    throw new Error(t('media.badHeic'));
  }
}

let cache = null; // { key, at, promise }

/** Como decodeHeic, recordando la ultima foto un rato (o la que se esta decodificando ya). */
async function decodeHeicCached(filePath) {
  const stat = await fs.stat(filePath);
  const key = `${filePath}|${stat.mtimeMs}|${stat.size}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.promise;
  const promise = decodeHeic(filePath);
  cache = { key, at: Date.now(), promise };
  promise.catch(() => {
    if (cache && cache.promise === promise) cache = null;
  });
  return promise;
}

/**
 * Una instancia de sharp lista para procesar la imagen, sea del formato que sea: para un HEIC, los
 * pixeles decodificados; para cualquier otro, el propio archivo. `sharpOptions` solo se usa en el segundo caso.
 */
async function openImage(filePath, sharpOptions = { failOn: 'none' }) {
  if (!isHeicPath(filePath)) return getSharp()(filePath, sharpOptions);
  const { width, height, rgba } = await decodeHeicCached(filePath);
  return getSharp()(rgba, { raw: { width, height, channels: 4 } });
}

/** Solo para pruebas y el cierre de la app: detiene el hilo. */
function shutdownHeicWorker() {
  dropWorker();
  cache = null;
}

module.exports = { isHeicPath, looksLikeHeic, decodeHeic, openImage, shutdownHeicWorker };
