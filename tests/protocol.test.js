'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');

function freshProtocol(baseDir) {
  process.env.COMPACTA_TEST_BASE_DIR = baseDir;
  delete require.cache[require.resolve('../src/main/protocol')];
  delete require.cache[require.resolve('../src/main/paths')];
  return require('../src/main/protocol');
}

test('resolveInsideBase acepta una ruta normal dentro de la carpeta base', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-proto-'));
  const { resolveInsideBase } = freshProtocol(dir);
  const result = resolveInsideBase(dir, 'Lote1/foto.jpg');
  assert.equal(result, path.join(dir, 'Lote1', 'foto.jpg'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('resolveInsideBase bloquea salir de la carpeta con ../..', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-proto-'));
  const { resolveInsideBase } = freshProtocol(dir);
  assert.equal(resolveInsideBase(dir, '../../etc/passwd'), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('resolveInsideBase NO se deja enganar por una carpeta hermana con el mismo prefijo (bug de startsWith)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-proto-'));
  const base = path.join(root, 'Compacta');
  const sibling = path.join(root, 'Compacta-otra-cosa');
  await fs.mkdir(sibling, { recursive: true });
  const { resolveInsideBase } = freshProtocol(base);
  // Un "../Compacta-otra-cosa/secreto.txt" desde base resuelve fuera de
  // `base`, pero con un startsWith(base) simple (sin separador) coincidia
  // igual porque "Compacta-otra-cosa" empieza con "Compacta".
  const result = resolveInsideBase(base, '../Compacta-otra-cosa/secreto.txt');
  assert.equal(result, null);
  await fs.rm(root, { recursive: true, force: true });
});

test('toSafeFileUrl / el protocolo van y vuelven para nombres con espacios y "#"', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-proto-'));
  const { toSafeFileUrl, resolveInsideBase } = freshProtocol(dir);
  const absolute = path.join(dir, 'Cumpleaños #1', 'foto final.jpg');
  const url = toSafeFileUrl(absolute);

  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'compacta-file:');
  // El "host" debe ser fijo: antes el primer tramo de la ruta (p.ej. "input")
  // se interpretaba como host y se perdia, y ninguna miniatura cargaba.
  assert.equal(parsed.host, 'app');

  const relative = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  const resolved = resolveInsideBase(dir, relative);
  assert.equal(resolved, absolute, 'la URL debe poder reconstruir la ruta original exacta');
});
