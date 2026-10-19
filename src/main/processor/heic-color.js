'use strict';

/**
 * Color de las fotos HEIC (iPhone). Funciones puras, sin dependencias: las usa el hilo que decodifica
 * (heic-worker.js) y las pruebas.
 *
 * Las fotos del iPhone vienen en el espacio de color Display P3, mas amplio que sRGB. libheif entrega los
 * numeros tal cual, SIN perfil: si se trataran como sRGB, los colores saldrian apagados (rojos y verdes
 * pierden viveza). Por eso, cuando la foto declara Display P3 se convierten a sRGB (lo que entiende
 * cualquier pantalla, navegador y programa; sharp hace lo mismo con los JPEG con perfil). Los colores
 * que solo existen en P3 y no caben en sRGB se recortan al limite: es inevitable al pasar a sRGB.
 */

/** Producto de matrices 3x3. */
function multiply(a, b) {
  return a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
}

// Display P3 (RGB lineal) -> XYZ D65, y XYZ D65 -> sRGB (RGB lineal). Valores de las especificaciones.
const P3_TO_XYZ = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0.0, 0.04511338185890264, 1.043944368900976]
];
const XYZ_TO_SRGB = [
  [3.2404541621, -1.5371385128, -0.4985314096],
  [-0.9692660305, 1.8760108454, 0.0415560175],
  [0.0556434310, -0.2040259135, 1.0572251882]
];
const P3_TO_SRGB = multiply(XYZ_TO_SRGB, P3_TO_XYZ);

// Display P3 usa la misma curva de tono que sRGB.
const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

const DECODE = new Float32Array(256).map((_, i) => toLinear(i / 255));
const ENCODE_STEPS = 16384; // pasos de la tabla inversa: suficiente para que no se noten escalones ni en las sombras
const ENCODE = new Uint8Array(ENCODE_STEPS + 1).map((_, i) => Math.round(fromLinear(i / ENCODE_STEPS) * 255));

/** Convierte IN SITU un buffer RGBA (8 bits) de Display P3 a sRGB. El canal alfa no se toca. */
function p3ToSrgbInPlace(rgba) {
  const [[a, b, c], [d, e, f], [g, h, i]] = P3_TO_SRGB;
  const clampIndex = (v) => (v <= 0 ? 0 : v >= 1 ? ENCODE_STEPS : (v * ENCODE_STEPS + 0.5) | 0);
  for (let p = 0; p + 3 < rgba.length; p += 4) {
    const r = DECODE[rgba[p]];
    const gr = DECODE[rgba[p + 1]];
    const bl = DECODE[rgba[p + 2]];
    rgba[p] = ENCODE[clampIndex(a * r + b * gr + c * bl)];
    rgba[p + 1] = ENCODE[clampIndex(d * r + e * gr + f * bl)];
    rgba[p + 2] = ENCODE[clampIndex(g * r + h * gr + i * bl)];
  }
  return rgba;
}

const UTF16BE_P3 = Buffer.from('Display P3', 'utf16le').swap16();

// Primarias (columnas rXYZ, gXYZ, bXYZ de un perfil ICC, adaptadas a D50) de Display P3.
const P3_COLORANTS = { rXYZ: [0.5151, 0.2412, -0.0011], gXYZ: [0.2920, 0.6922, 0.0419], bXYZ: [0.1571, 0.0666, 0.7841] };
const COLORANT_TOLERANCE = 0.012;

/**
 * ¿Son las primarias de este perfil ICC las de Display P3? Se miran las etiquetas rXYZ/gXYZ/bXYZ (tres
 * numeros s15Fixed16 cada una) en vez de fiarse del NOMBRE: segun quien lo escriba, el mismo espacio se llama
 * «Display P3», «sP3C», «P3-D65»... y un perfil mal nombrado pasaria por sRGB con los colores apagados.
 */
function iccHasP3Primaries(icc) {
  if (icc.length < 132) return false;
  const count = icc.readUInt32BE(128);
  const found = {};
  for (let k = 0; k < count && 132 + 12 * (k + 1) <= icc.length; k += 1) {
    const at = 132 + 12 * k;
    const signature = icc.toString('latin1', at, at + 4);
    if (!(signature in P3_COLORANTS)) continue;
    const offset = icc.readUInt32BE(at + 4);
    if (offset + 20 > icc.length || icc.toString('latin1', offset, offset + 4) !== 'XYZ ') return false;
    found[signature] = [0, 1, 2].map((i) => icc.readInt32BE(offset + 8 + 4 * i) / 65536);
  }
  return Object.entries(P3_COLORANTS).every(([signature, expected]) => found[signature] && expected.every((v, i) => Math.abs(found[signature][i] - v) <= COLORANT_TOLERANCE));
}

/**
 * ¿Declara el HEIC que esta en Display P3? Se busca la propiedad de color ("colr") del archivo:
 *  - 'nclx': primarias de color 12 = Display P3 (SMPTE EG 432-1);
 *  - 'prof' / 'rICC': un perfil ICC incrustado con las primarias de Display P3 (o, como pista extra, con ese nombre).
 * Cualquier otra cosa (sin propiedad, sRGB, un perfil desconocido) se deja como esta.
 */
function detectDisplayP3(buffer) {
  let from = 0;
  for (let guard = 0; guard < 64; guard += 1) {
    const at = buffer.indexOf('colr', from, 'latin1');
    if (at < 4 || at + 8 > buffer.length) return false;
    from = at + 4;
    const size = buffer.readUInt32BE(at - 4);
    const kind = buffer.toString('latin1', at + 4, at + 8);
    if (kind === 'nclx' && at + 10 <= buffer.length) {
      if (buffer.readUInt16BE(at + 8) === 12) return true;
    } else if ((kind === 'prof' || kind === 'rICC') && size > 12 && at - 4 + size <= buffer.length) {
      const icc = buffer.subarray(at + 8, at - 4 + size);
      if (iccHasP3Primaries(icc) || icc.includes('Display P3', 0, 'latin1') || icc.includes(UTF16BE_P3)) return true;
    }
  }
  return false;
}

module.exports = { p3ToSrgbInPlace, detectDisplayP3, iccHasP3Primaries };
