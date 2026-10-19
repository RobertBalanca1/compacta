'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const i18n = require('../src/shared/i18n');
const es = require('../src/shared/locales/es.js');

const SRC = path.join(__dirname, '..', 'src');
const PLURAL = /\.(zero|one|two|few|many|other)$/;
const base = (key) => key.replace(PLURAL, '');
const paramsOf = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

test('hay 6 idiomas y cada uno trae TODOS los textos del español (con sus formas de plural)', () => {
  assert.deepEqual(i18n.CODES, ['es', 'en', 'de', 'it', 'vi', 'ar']);
  const esBases = new Set(Object.keys(es).map(base));
  for (const code of i18n.CODES) {
    const dictionary = require(`../src/shared/locales/${code}.js`);
    const bases = new Set(Object.keys(dictionary).map(base));
    assert.deepEqual([...esBases].filter((b) => !bases.has(b)), [], `${code}: faltan textos`);
    assert.deepEqual([...bases].filter((b) => !esBases.has(b)), [], `${code}: sobran textos que el español no tiene`);
    for (const key of bases) {
      const isPlural = Object.keys(es).some((k) => base(k) === key && PLURAL.test(k));
      if (isPlural) assert.ok(`${key}.other` in dictionary, `${code}: ${key} necesita la forma .other`);
    }
    for (const [key, text] of Object.entries(dictionary)) assert.ok(String(text).trim().length > 0, `${code}: ${key} está vacío`);
  }
});

test('cada idioma usa los MISMOS {parametros} que el español (si no, el texto saldría con un hueco)', () => {
  for (const code of i18n.CODES) {
    const dictionary = require(`../src/shared/locales/${code}.js`);
    for (const [key, text] of Object.entries(dictionary)) {
      const reference = es[key] ?? es[`${base(key)}.other`] ?? es[`${base(key)}.one`];
      assert.ok(reference !== undefined, `${code}: ${key} no existe en español`);
      // Las formas «una» y «dos» de un plural pueden decir el número con palabras («ملف واحد») y no llevar {count}.
      const countless = /\.(one|two)$/.test(key) && paramsOf(reference).replace('count', '') !== paramsOf(reference);
      const expected = countless ? paramsOf(reference).split(',').filter((p) => p !== 'count').join(',') : paramsOf(reference);
      const got = paramsOf(text);
      assert.ok(got === paramsOf(reference) || got === expected, `${code}: ${key} usa {${got}} y el español {${paramsOf(reference)}}`);
    }
  }
});

test('todo texto que el código o el HTML piden existe en español (no se queda ninguna clave pelada)', () => {
  const namespaces = new Set(Object.keys(es).map((key) => key.split('.')[0]));
  const known = new Set(Object.keys(es).map(base));
  const literal = new RegExp(`['"\`]((?:${[...namespaces].join('|')})\\.[A-Za-z0-9.]+)['"\`]`, 'g');
  const missing = [];
  for (const file of walk(SRC).filter((f) => /\.(js|html)$/.test(f) && !f.includes(`${path.sep}locales${path.sep}`))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(literal)) {
      const key = match[1];
      if (/\.(json|js|html|css|png|lock)$/.test(key)) continue; // un nombre de archivo, no un texto
      if (!known.has(key) && !known.has(base(key))) missing.push(`${path.relative(SRC, file)}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('el idioma sale del ajuste, y si es automático, del primer idioma del sistema que se soporte', () => {
  assert.equal(i18n.resolveLanguage('de', ['es-ES']), 'de', 'lo elegido manda');
  assert.equal(i18n.resolveLanguage(null, ['es-ES']), 'es');
  assert.equal(i18n.resolveLanguage(null, ['ar_SA']), 'ar');
  assert.equal(i18n.resolveLanguage(null, ['pt-BR', 'vi-VN']), 'vi', 'salta lo que no se soporta');
  assert.equal(i18n.resolveLanguage(null, ['fr-FR']), 'en', 'sin ninguno soportado, inglés');
  assert.equal(i18n.resolveLanguage('klingon', ['it-IT']), 'it', 'un valor inválido equivale a automático');
  assert.equal(i18n.resolveLanguage(null, []), 'en');
});

test('plurales: cada idioma elige su forma (el árabe distingue uno, dos, pocos, muchos y el resto)', (t) => {
  t.after(() => i18n.setLanguage('es'));
  i18n.setLanguage('es');
  assert.equal(i18n.t('notify.done', { count: 1 }), 'Listo: 1 archivo comprimido');
  assert.equal(i18n.t('notify.done', { count: 7 }), 'Listo: 7 archivos comprimidos');
  i18n.setLanguage('en');
  assert.equal(i18n.t('notify.done', { count: 1 }), 'Done: 1 file compressed');
  assert.equal(i18n.t('notify.done', { count: 12 }), 'Done: 12 files compressed');
  i18n.setLanguage('vi');
  assert.equal(i18n.t('notify.done', { count: 1 }), 'Xong: đã nén 1 tệp', 'sin plural: la forma .other sirve para todo');
  i18n.setLanguage('ar');
  assert.match(i18n.t('notify.done', { count: 1 }), /ملف واحد/);
  assert.match(i18n.t('notify.done', { count: 2 }), /ملفين/);
  assert.match(i18n.t('notify.done', { count: 5 }), /5 ملفات/);
  assert.match(i18n.t('notify.done', { count: 15 }), /15 ملفًا/);
  assert.match(i18n.t('notify.done', { count: 150 }), /150 ملفًا/, '150 es «muchos» (150 % 100 = 50)');
  assert.match(i18n.t('notify.done', { count: 100 }), /100 ملف$/, '100, 200… son «el resto»');
});

test('un texto que falta cae al inglés, luego al español, y nunca queda una clave a medias', (t) => {
  t.after(() => i18n.setLanguage('es'));
  i18n.setLanguage('de');
  assert.equal(i18n.t('clave.que.no.existe'), 'clave.que.no.existe');
  assert.equal(i18n.t('queue.saved', { size: '3 MB' }), '3 MB gespart');
  assert.equal(i18n.t('queue.saved'), '{size} gespart', 'un parámetro sin dar se deja visible, no se borra');
  assert.equal(i18n.setLanguage('zz'), 'es', 'un idioma desconocido vuelve al español');
});

test('el árabe va de derecha a izquierda y el resto de izquierda a derecha', () => {
  assert.equal(i18n.directionOf('ar'), 'rtl');
  for (const code of ['es', 'en', 'de', 'it', 'vi']) assert.equal(i18n.directionOf(code), 'ltr');
});

test('el ajuste de idioma solo admite los idiomas conocidos (o null = automático)', async () => {
  process.env.COMPACTA_TEST_BASE_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'compacta-lang-'));
  const { saveSettings, loadSettings } = require('../src/main/settings-store');
  assert.equal(saveSettings({ language: 'de' }).language, 'de');
  assert.equal(saveSettings({ language: 'klingon' }).language, null);
  assert.equal(saveSettings({ language: 'ar' }).language, 'ar');
  assert.equal(saveSettings({ language: null }).language, null);
  assert.equal(loadSettings().language, null);
});

test('los avisos del proceso principal salen en el idioma elegido', (t) => {
  t.after(() => i18n.setLanguage('es'));
  const { describeBatch } = require('../src/main/notifier');
  const summary = { done: 6, errors: 1, savedBytes: 5 * 1024 * 1024 };
  i18n.setLanguage('es');
  assert.equal(describeBatch(summary), 'Listo: 6 archivos comprimidos — ahorraste 5.0 MB (1 con error)');
  i18n.setLanguage('en');
  assert.equal(describeBatch(summary), 'Done: 6 files compressed — you saved 5.0 MB (1 with errors)');
  i18n.setLanguage('it');
  assert.match(describeBatch(summary), /^Fatto: 6 file compressi/);
});

test('isolate: en árabe aísla lo que debe leerse de izquierda a derecha (tamaños, medidas); en los demás no toca nada', (t) => {
  t.after(() => i18n.setLanguage('es'));
  i18n.setLanguage('en');
  assert.equal(i18n.isolate('2.1 MB'), '2.1 MB');
  i18n.setLanguage('ar');
  assert.equal(i18n.isolate('2.1 MB'), '\u20662.1 MB\u2069');
  const { describeBatch } = require('../src/main/notifier');
  assert.ok(describeBatch({ done: 6, errors: 1, savedBytes: 3 * 1024 * 1024 }).includes('\u20663.0 MB\u2069'), 'el aviso del sistema también aísla el tamaño');
});
