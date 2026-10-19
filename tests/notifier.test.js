'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const notifier = require('../src/main/notifier');

function fakeWindow({ focused = true, destroyed = false } = {}) {
  const sent = [];
  let flashed = 0;
  return {
    sent,
    get flashed() { return flashed; },
    isDestroyed: () => destroyed,
    isFocused: () => focused,
    flashFrame: () => { flashed += 1; },
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) }
  };
}

test('describeBatch: menos de 5 archivos no genera aviso', () => {
  assert.equal(notifier.describeBatch({ done: 4, errors: 0, savedBytes: 5000 }), null);
  assert.equal(notifier.describeBatch(null), null);
});

test('describeBatch: 5 o mas archivos si, con el ahorro y los errores', () => {
  const text = notifier.describeBatch({ done: 6, errors: 1, savedBytes: 3 * 1024 * 1024 });
  assert.match(text, /6 archivos comprimidos/);
  assert.match(text, /3\.0 MB/);
  assert.match(text, /1 con error/);
});

test('formatBytes: unidades razonables', () => {
  assert.equal(notifier.formatBytes(0), '0 B');
  assert.equal(notifier.formatBytes(2048), '2.0 KB');
  assert.equal(notifier.formatBytes(50 * 1024 * 1024), '50 MB');
});

test('announceBatchFinished avisa dentro de la app Y por el sistema, aunque la ventana tenga el foco', () => {
  const shown = [];
  notifier.setNotificationFactory((opts) => ({ show: () => shown.push(opts) }));
  const win = fakeWindow({ focused: true });

  const message = notifier.announceBatchFinished({ done: 8, errors: 0, savedBytes: 1024 * 1024 }, win);

  assert.match(message, /8 archivos comprimidos/);
  assert.equal(shown.length, 1, 'debe haber notificacion del sistema aunque la ventana este enfocada');
  assert.deepEqual(win.sent.map((m) => m.channel), ['queue:batch-finished']);
  assert.equal(win.flashed, 0, 'con la ventana enfocada no hace falta pedir atencion');
});

test('announceBatchFinished con la ventana en segundo plano pide atencion', () => {
  notifier.setNotificationFactory(() => ({ show() {} }));
  const win = fakeWindow({ focused: false });
  notifier.announceBatchFinished({ done: 5, errors: 0, savedBytes: 0 }, win);
  assert.equal(win.flashed, 1);
});

test('announceBatchFinished sin ventana (ya cerrada) no falla y sigue notificando', () => {
  const shown = [];
  notifier.setNotificationFactory((opts) => ({ show: () => shown.push(opts) }));
  assert.doesNotThrow(() => notifier.announceBatchFinished({ done: 9, errors: 0, savedBytes: 0 }, null));
  assert.equal(shown.length, 1);
});

test('si la notificacion del sistema falla, el aviso dentro de la app se envia igual', () => {
  notifier.setNotificationFactory(() => { throw new Error('sin permiso de notificaciones'); });
  const win = fakeWindow();
  assert.doesNotThrow(() => notifier.announceBatchFinished({ done: 7, errors: 0, savedBytes: 0 }, win));
  assert.equal(win.sent.length, 1, 'el aviso verde dentro de la app no puede depender del sistema operativo');
});

test('lote pequeño: no avisa por ningun canal', () => {
  const shown = [];
  notifier.setNotificationFactory((opts) => ({ show: () => shown.push(opts) }));
  const win = fakeWindow();
  assert.equal(notifier.announceBatchFinished({ done: 2, errors: 0, savedBytes: 10 }, win), null);
  assert.equal(shown.length, 0);
  assert.equal(win.sent.length, 0);
});
