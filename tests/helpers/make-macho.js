'use strict';

// Fabrica binarios Mach-O DE VERDAD (cabecera y comandos de carga validos) para probar el lector sin un Mac.

const CPU = { x64: 0x01000007, arm64: 0x0100000c };
const pack = (major, minor = 0, patch = 0) => ((major << 16) | (minor << 8) | patch) >>> 0;

/** Una rebanada (una arquitectura). `command`: 'build' (LC_BUILD_VERSION) o 'min' (LC_VERSION_MIN_MACOSX); null = sin version. */
function thinMacho({ arch, minos, command = 'build' }) {
  let load = Buffer.alloc(0);
  if (command === 'build') {
    load = Buffer.alloc(24);
    load.writeUInt32LE(0x32, 0);
    load.writeUInt32LE(24, 4);
    load.writeUInt32LE(1, 8); // plataforma: macOS
    load.writeUInt32LE(pack(...minos), 12);
  } else if (command === 'min') {
    load = Buffer.alloc(16);
    load.writeUInt32LE(0x24, 0);
    load.writeUInt32LE(16, 4);
    load.writeUInt32LE(pack(...minos), 8);
  }
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(CPU[arch], 4);
  header.writeUInt32LE(command ? 1 : 0, 16); // ncmds
  header.writeUInt32LE(load.length, 20); // sizeofcmds
  return Buffer.concat([header, load, Buffer.alloc(64)]);
}

/** Binario «fat» (como el que deja `lipo`): tabla + rebanadas en desplazamientos multiplos de 4096. */
function fatMacho(slices, { bits64 = false } = {}) {
  const entrySize = bits64 ? 32 : 20;
  const table = Buffer.alloc(8 + slices.length * entrySize);
  table.writeUInt32BE(bits64 ? 0xcafebabf : 0xcafebabe, 0);
  table.writeUInt32BE(slices.length, 4);
  const parts = [];
  let offset = 4096;
  slices.forEach((slice, i) => {
    const at = 8 + i * entrySize;
    table.writeUInt32BE(slice.readUInt32LE(4), at); // cputype
    if (bits64) table.writeBigUInt64BE(BigInt(offset), at + 8);
    else table.writeUInt32BE(offset, at + 8);
    parts.push(Buffer.alloc(offset - (parts.reduce((n, p) => n + p.length, 0) + table.length)), slice);
    offset += Math.ceil(slice.length / 4096) * 4096;
  });
  return Buffer.concat([table, ...parts]);
}

module.exports = { thinMacho, fatMacho, pack };
