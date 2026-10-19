'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function freshPaths(baseDirOverride) {
  process.env.COMPACTA_TEST_BASE_DIR = baseDirOverride;
  delete require.cache[require.resolve('../src/main/paths')];
  return require('../src/main/paths');
}

test('isBaseDirCloudSynced detecta OneDrive en la ruta (Windows)', () => {
  const paths = freshPaths(path.join('C:', 'Users', 'Ana', 'OneDrive', 'Documentos', 'Compacta'));
  assert.equal(paths.isBaseDirCloudSynced(), true);
});

test('isBaseDirCloudSynced detecta iCloud Drive en la ruta (Mac)', () => {
  const paths = freshPaths('/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/Documents/Compacta');
  assert.equal(paths.isBaseDirCloudSynced(), true);
});

test('isBaseDirCloudSynced no marca falso positivo en una carpeta local normal', () => {
  const paths = freshPaths('/home/ana/Documents/Compacta');
  assert.equal(paths.isBaseDirCloudSynced(), false);
});
