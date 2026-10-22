'use strict';

const fs = require('fs');

/**
 * Lector de cabeceras Mach-O (los ejecutables y librerias de macOS). Sin dependencias y sin ejecutar nada: lee los
 * primeros bytes de un archivo.
 *
 * Lo usan dos cosas:
 *  - la propia app (ffmpeg.js): saber si el ffmpeg incluido lleva la parte Intel, para usar Rosetta en un Mac con
 *    chip Apple y macOS 11 (donde la parte nativa, que pide macOS 12, no arranca);
 *  - `scripts/mac-app-tools.js`: comprobar un `.app` construido (arquitecturas y macOS minimo de CADA pieza) desde
 *    Linux o desde el propio Mac.
 * Las funciones `machoArchitectures` y `machoMinOs` son puras (reciben un Buffer): se prueban sin un Mac.
 */

const CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64' };
const FAT_32 = 0xcafebabe;
const FAT_64 = 0xcafebabf;
const THIN_64_LE = 0xfeedfacf; // Mach-O de 64 bits; los campos van en el orden de la CPU (little-endian)
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const MAX_FAT_ENTRIES = 8;

/** Entradas de la tabla de un binario «fat» (el que deja `lipo`): [{ arch, offset }]; null si no es fat. */
function fatTable(head) {
  if (!head || head.length < 8) return null;
  const magic = head.readUInt32BE(0);
  if (magic !== FAT_32 && magic !== FAT_64) return null;
  const entrySize = magic === FAT_64 ? 32 : 20;
  const count = Math.min(head.readUInt32BE(4), MAX_FAT_ENTRIES);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = 8 + i * entrySize;
    if (at + entrySize > head.length) break;
    const arch = CPU[head.readUInt32BE(at)];
    if (!arch) continue;
    const offset = magic === FAT_64 ? Number(head.readBigUInt64BE(at + 8)) : head.readUInt32BE(at + 8);
    entries.push({ arch, offset });
  }
  return entries;
}

/**
 * Arquitecturas que lleva un ejecutable de macOS, leyendo solo su cabecera: 'x64' / 'arm64' (array vacio si no es un
 * Mach-O o no se entiende). Un binario fat las lista todas; uno normal lleva una sola.
 */
function machoArchitectures(head) {
  const fat = fatTable(head);
  if (fat) return fat.map((entry) => entry.arch);
  if (!head || head.length < 8 || head.readUInt32LE(0) !== THIN_64_LE) return [];
  const arch = CPU[head.readUInt32LE(4)];
  return arch ? [arch] : [];
}

function formatVersion(packed) {
  return `${packed >>> 16}.${(packed >>> 8) & 0xff}.${packed & 0xff}`;
}

/**
 * macOS minimo que declara UNA rebanada (arquitectura) de un Mach-O de 64 bits, como «13.0.0»; null si no lo dice. `slice` es
 * un Buffer que empieza en la cabecera de esa rebanada y llega al menos hasta el final de sus comandos de carga.
 */
function machoMinOs(slice) {
  if (!slice || slice.length < 32 || slice.readUInt32LE(0) !== THIN_64_LE) return null;
  const commands = slice.readUInt32LE(16);
  let offset = 32;
  for (let i = 0; i < commands; i++) {
    if (offset + 8 > slice.length) return null;
    const command = slice.readUInt32LE(offset);
    const size = slice.readUInt32LE(offset + 4);
    if (size < 8) return null;
    if (command === LC_BUILD_VERSION && offset + 16 <= slice.length) return formatVersion(slice.readUInt32LE(offset + 12));
    if (command === LC_VERSION_MIN_MACOSX && offset + 12 <= slice.length) return formatVersion(slice.readUInt32LE(offset + 8));
    offset += size;
  }
  return null;
}

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, read);
}

/** Lee la cabecera de una rebanada que empieza en `offset` y devuelve { arch, minos } (minos puede ser null). */
function readSlice(fd, offset, arch) {
  const header = readAt(fd, offset, 32);
  if (header.length < 32 || header.readUInt32LE(0) !== THIN_64_LE) return null;
  const commandsSize = Math.min(header.readUInt32LE(20), 1 << 20);
  const commands = readAt(fd, offset + 32, commandsSize);
  return { arch: arch || CPU[header.readUInt32LE(4)] || null, minos: machoMinOs(Buffer.concat([header, commands])) };
}

/** Arquitecturas de un archivo, leyendo solo su cabecera ([] si no es un Mach-O o no se puede leer). */
function readMachoArchitectures(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    return machoArchitectures(readAt(fd, 0, 8 + MAX_FAT_ENTRIES * 32));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Las rebanadas de un archivo con su macOS minimo: [{ arch, minos }] ([] si no es un Mach-O o no se puede leer). */
function readMachoSlices(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = readAt(fd, 0, 8 + MAX_FAT_ENTRIES * 32);
    const fat = fatTable(head);
    const slices = fat ? fat.map((entry) => readSlice(fd, entry.offset, entry.arch)) : [readSlice(fd, 0, null)];
    return slices.filter((slice) => slice && slice.arch);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { machoArchitectures, machoMinOs, readMachoArchitectures, readMachoSlices };
