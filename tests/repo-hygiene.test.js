'use strict';

// Que tres cosas que deben decir lo mismo no se desincronicen: el Node que piden package.json y el README, y el que usa GitHub;
// y que el repositorio fije los finales de linea (si no, el paquete de Windows lleva archivos distintos en bytes a los de Mac y Linux).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('el Node que pide package.json, el que dice el README y el que usa GitHub coinciden', () => {
  const required = /(\d+)\.(\d+)/.exec(pkg.engines.node);
  assert.ok(required, 'package.json declara engines.node');
  const ci = [...read('.github', 'workflows', 'build.yml').matchAll(/node-version:\s*(\d+)/g)].map((m) => m[1]);
  assert.ok(ci.length >= 3, 'el flujo fija el Node en todos sus trabajos');
  for (const major of ci) assert.equal(major, required[1], `el flujo usa Node ${major} y package.json pide ${pkg.engines.node}`);
  assert.match(read('README.md'), new RegExp(`Node\\.js\\]\\(https://nodejs\\.org\\) ${required[1]}\\.${required[2]} o superior`));
  assert.ok(Number(process.versions.node.split('.')[0]) >= Number(required[1]) || process.versions.electron, 'estas pruebas corren con el Node que pide el proyecto');
});

test('.gitattributes fija LF en todo el repositorio y marca los binarios', () => {
  const text = read('.gitattributes');
  assert.match(text, /^\* text=auto eol=lf$/m);
  for (const extension of ['png', 'ico', 'icns']) assert.match(text, new RegExp(`^\\*\\.${extension} binary$`, 'm'));
});

test('ningun archivo de codigo del repositorio lleva finales de linea de Windows (CRLF)', () => {
  const offenders = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'vendor', '.git'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(js|json|md|yml|html|css|strings|txt)$/.test(entry.name) && fs.readFileSync(full).includes('\r\n')) offenders.push(path.relative(ROOT, full));
    }
  };
  visit(ROOT);
  assert.deepEqual(offenders, [], 'archivos con CRLF: normalizar a LF');
});
