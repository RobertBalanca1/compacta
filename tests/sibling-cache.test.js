'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { optimizeImage } = require('../src/main/processor/raster-optimizer');

async function make(file, color) {
  await sharp({ create: { width: 300, height: 200, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 40 } } })
    .jpeg({ quality: 98 }).toFile(file);
}

test('el listado en cache de la carpeta se invalida si aparece un hermano con otra extension', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-sib-'));
  const out = path.join(dir, 'out');
  await fs.mkdir(out);
  await make(path.join(dir, 'foto.jpg'));

  const first = await optimizeImage(path.join(dir, 'foto.jpg'), path.join(out, 'foto.jpg'), { quality: 80 });
  assert.equal(path.basename(first.output), 'foto.jpg', 'sin hermano, el nombre no cambia');

  await new Promise((r) => setTimeout(r, 60)); // asegurar mtime de carpeta distinto
  await sharp({ create: { width: 50, height: 50, channels: 3, background: '#00ff00' } }).png().toFile(path.join(dir, 'foto.png'));

  const second = await optimizeImage(path.join(dir, 'foto.jpg'), path.join(out, 'foto.jpg'), { quality: 80 });
  assert.equal(path.basename(second.output), 'foto_jpg.jpg', 'con foto.png al lado, deben diferenciarse (no pisarse)');
  await fs.rm(dir, { recursive: true, force: true });
});
