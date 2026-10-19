'use strict';

/**
 * Descifrado de entradas de un ZIP con contrasena (1.1.0). Sin dependencias: solo `crypto` de Node.
 *
 * Dos cifrados, los dos que existen en la practica:
 *  - ZipCrypto (el clasico, el de `zip -P` y el de Windows): cifrado de flujo simple y debil, pero es el que
 *    mas ZIP traen. Su comprobacion de contrasena es de UN byte (1 de cada 256 contrasenas malas pasa), asi que
 *    ademas se verifica el CRC32 de lo descomprimido: una contrasena mala nunca produce un archivo «bueno».
 *  - AES de WinZip (metodo 99, AES-128/192/256): contrasena -> PBKDF2-HMAC-SHA1 (1000 vueltas) -> clave de
 *    cifrado + clave de autenticacion + 2 bytes de comprobacion. Los datos se autentican con HMAC-SHA1 (10 bytes
 *    al final), asi que cualquier alteracion o contrasena equivocada se detecta.
 *
 * Todo en STREAMING (sin cargar el archivo en memoria): un video de varios GB se descifra al vuelo.
 * Las contrasenas viven solo en memoria durante la importacion: no se guardan ni se escriben en ningun sitio.
 */

const crypto = require('crypto');
const zlib = require('zlib');
const { Transform, PassThrough, pipeline } = require('stream');
const { ArchiveError } = require('./archive-errors');

// ---------------------------------------------------------------- CRC32
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32Update(crc, buffer) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const wrongPassword = () => new ArchiveError('wrong-password', 'wrong password');

// ---------------------------------------------------------------- ZipCrypto
function zipCryptoDecrypter(password, acceptedCheckBytes) {
  // Las tres claves, en variables locales: este bucle corre por CADA byte del archivo (un video de 1 GB son mil
  // millones de vueltas) y las llamadas a funciones por byte lo hacian 3 veces mas lento.
  let k0 = 0x12345678;
  let k1 = 0x23456789;
  let k2 = 0x34567890;
  const update = (byte) => {
    k0 = CRC_TABLE[(k0 ^ byte) & 0xff] ^ (k0 >>> 8);
    k1 = (Math.imul((k1 + (k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    k2 = CRC_TABLE[(k2 ^ (k1 >>> 24)) & 0xff] ^ (k2 >>> 8);
  };
  for (const byte of Buffer.from(password, 'utf8')) update(byte);

  let header = 0; // bytes de la cabecera de 12 que ya se leyeron
  return new Transform({
    transform(chunk, _encoding, callback) {
      const skip = Math.min(chunk.length, 12 - header); // la cabecera aleatoria de 12 bytes no es parte del archivo
      const out = Buffer.allocUnsafe(chunk.length);
      for (let i = 0; i < chunk.length; i += 1) {
        const temp = (k2 | 2) & 0xffff;
        const plain = chunk[i] ^ (((temp * (temp ^ 1)) >>> 8) & 0xff);
        k0 = CRC_TABLE[(k0 ^ plain) & 0xff] ^ (k0 >>> 8);
        k1 = (Math.imul((k1 + (k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
        k2 = CRC_TABLE[(k2 ^ (k1 >>> 24)) & 0xff] ^ (k2 >>> 8);
        out[i] = plain;
        if (header < 12) {
          header += 1;
          // El ultimo byte de la cabecera es el byte de comprobacion: no coincide -> contrasena equivocada.
          if (header === 12 && !acceptedCheckBytes.includes(plain)) return callback(wrongPassword());
        }
      }
      return callback(null, out.subarray(skip));
    },
    flush(callback) {
      callback(header < 12 ? wrongPassword() : null);
    }
  });
}

// ---------------------------------------------------------------- AES de WinZip
const AES_STRENGTH = { 1: { keyLength: 16, saltLength: 8 }, 2: { keyLength: 24, saltLength: 12 }, 3: { keyLength: 32, saltLength: 16 } };
const AUTH_LENGTH = 10;

/** Los datos de la extension 0x9901 de una entrada AES (o null si no es AES). */
function aesInfo(entry) {
  if (entry.compressionMethod !== 99) return null;
  const field = (entry.extraFields || []).find((f) => f.id === 0x9901);
  if (!field || field.data.length < 7) throw new ArchiveError('unsupported-method', 'AES extra field missing');
  const strength = AES_STRENGTH[field.data[4]];
  if (!strength) throw new ArchiveError('unsupported-method', 'AES strength');
  return { ...strength, version: field.data.readUInt16LE(0), method: field.data.readUInt16LE(5) };
}

function aesDecrypter(password, info) {
  let pending = Buffer.alloc(0); // hasta tener sal + verificador
  let derived = null;
  let cipher = null;
  let hmac = null;
  let tail = Buffer.alloc(0); // los ultimos bytes del flujo podrian ser el codigo de autenticacion
  let block = 0; // contador de bloques de 16 bytes (en WinZip es little-endian y empieza en 1)
  let keystream = Buffer.alloc(0);

  const nextKeystream = (length) => {
    if (keystream.length >= length) return;
    const need = Math.ceil((length - keystream.length) / 16);
    const counters = Buffer.alloc(need * 16);
    for (let i = 0; i < need; i += 1) {
      block += 1;
      counters.writeUInt32LE(block >>> 0, i * 16);
      counters.writeUInt32LE(Math.floor(block / 0x100000000), i * 16 + 4);
    }
    keystream = Buffer.concat([keystream, cipher.update(counters)]);
  };

  const decrypt = (data) => {
    hmac.update(data);
    nextKeystream(data.length);
    const out = Buffer.allocUnsafe(data.length);
    for (let i = 0; i < data.length; i += 1) out[i] = data[i] ^ keystream[i];
    keystream = keystream.subarray(data.length);
    return out;
  };

  return new Transform({
    transform(chunk, _encoding, callback) {
      let data = chunk;
      if (!derived) {
        pending = Buffer.concat([pending, chunk]);
        const headerLength = info.saltLength + 2;
        if (pending.length < headerLength) return callback();
        const salt = pending.subarray(0, info.saltLength);
        const verifier = pending.subarray(info.saltLength, headerLength);
        const material = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 1000, info.keyLength * 2 + 2, 'sha1');
        derived = { encKey: material.subarray(0, info.keyLength), authKey: material.subarray(info.keyLength, info.keyLength * 2) };
        if (!crypto.timingSafeEqual(material.subarray(info.keyLength * 2), verifier)) return callback(wrongPassword());
        cipher = crypto.createCipheriv(`aes-${info.keyLength * 8}-ecb`, derived.encKey, null);
        cipher.setAutoPadding(false);
        hmac = crypto.createHmac('sha1', derived.authKey);
        data = pending.subarray(headerLength);
        pending = null;
      }
      const all = Buffer.concat([tail, data]);
      if (all.length <= AUTH_LENGTH) {
        tail = all;
        return callback();
      }
      tail = all.subarray(all.length - AUTH_LENGTH);
      return callback(null, decrypt(all.subarray(0, all.length - AUTH_LENGTH)));
    },
    flush(callback) {
      if (!derived || tail.length !== AUTH_LENGTH) return callback(wrongPassword());
      const expected = hmac.digest().subarray(0, AUTH_LENGTH);
      callback(crypto.timingSafeEqual(expected, tail) ? null : new ArchiveError('corrupt', 'AES authentication failed'));
    }
  });
}

// ---------------------------------------------------------------- comprobaciones de lo descifrado
/** Corta si salen mas bytes que los declarados (anti zip-bomb, igual que validateEntrySizes en lo normal). */
function sizeLimiter(maxBytes) {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      seen += chunk.length;
      callback(seen > maxBytes ? new ArchiveError('too-big', 'size mismatch') : null, chunk);
    }
  });
}

/** Comprueba el CRC32 del archivo ya descomprimido. `onMismatch` decide que error es. */
function crcVerifier(expected, onMismatch) {
  let crc = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      crc = crc32Update(crc, chunk);
      callback(null, chunk);
    },
    flush(callback) {
      callback(crc === expected ? null : onMismatch());
    }
  });
}

/**
 * Lee una entrada cifrada: `raw` es el flujo CRUDO de yauzl (sin descifrar ni descomprimir). Devuelve un flujo
 * con el archivo en claro. Un error en cualquier etapa llega al flujo devuelto.
 */
function decryptEntry(raw, entry, password) {
  const aes = aesInfo(entry);
  const method = aes ? aes.method : entry.compressionMethod;
  if (method !== 0 && method !== 8) throw new ArchiveError('unsupported-method', `compression method ${method}`);

  const stages = [raw];
  if (aes) {
    stages.push(aesDecrypter(password, aes));
  } else {
    // Byte de comprobacion: el alto del CRC o, si hay descriptor de datos (bit 3), el alto de la hora.
    const checks = [(entry.crc32 >>> 24) & 0xff, (entry.lastModFileTime >>> 8) & 0xff];
    stages.push(zipCryptoDecrypter(password, checks));
  }
  if (method === 8) stages.push(zlib.createInflateRaw());
  stages.push(sizeLimiter(entry.uncompressedSize));
  // AE-2 no guarda CRC (vale 0; ya lo cubre el HMAC). En ZipCrypto el CRC es lo que atrapa la contrasena falsa que
  // paso la comprobacion de un byte: por eso un CRC que no cuadra se informa como contrasena equivocada.
  if (!aes) stages.push(crcVerifier(entry.crc32 >>> 0, wrongPassword));
  else if (aes.version === 1) stages.push(crcVerifier(entry.crc32 >>> 0, () => new ArchiveError('corrupt', 'crc mismatch')));

  // `out` queda FUERA del pipeline a proposito: si estuviera dentro, pipeline lo destruiria con el error ORIGINAL (p. ej.
  // el de zlib) antes de que se pudiera convertir, y quien lee veria «dañado» en vez de «contrasena equivocada».
  const out = new PassThrough();
  // Sin un oyente, un error que llegue ANTES de que quien lee se enganche seria una excepcion sin capturar; quien lee lo
  // recibe igualmente (un flujo ya destruido con error lo informa al engancharse).
  out.on('error', () => {});
  pipeline(...stages, (err) => {
    if (!err) return;
    // Con ZipCrypto, una contrasena equivocada que supero el byte de comprobacion (1 de cada ~128) produce datos basura:
    // revienta al descomprimir, se pasa del tamano declarado o no cuadra el CRC. Todo eso, aqui, ES una contrasena
    // equivocada, salvo un fallo del propio disco (ENOENT, EIO...) que se deja tal cual.
    const diskError = typeof err.code === 'string' && /^E[A-Z]+$/.test(err.code);
    out.destroy(!aes && !diskError ? wrongPassword() : err);
  });
  stages[stages.length - 1].pipe(out);
  return out;
}

module.exports = { decryptEntry };
