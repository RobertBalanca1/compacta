'use strict';

/**
 * Prueba de interfaz de los IDIOMAS (1.1.0): levanta la app REAL, abre su ventana y cambia de idioma desde
 * Ajustes como lo haria una persona. Comprueba que el cambio es inmediato y completo, que el arabe pasa a
 * derecha-a-izquierda, que ningun texto desborda o queda recortado en ningun idioma, y que el proceso
 * principal tambien habla el idioma elegido. Guarda capturas en $COMPACTA_SHOTS (si esta definida).
 *
 * Uso:  xvfb-run -a npx electron --no-sandbox tests/ui-i18n-electron.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, dialog } = require('electron');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compacta-ui-i18n-'));
app.setPath('userData', path.join(tmpRoot, 'userData'));
app.setPath('documents', path.join(tmpRoot, 'Documents'));
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });

const watchdog = setTimeout(() => { console.error('WATCHDOG'); app.exit(2); }, 120000);

require('../src/main/index.js');
const sharp = require('sharp');
const i18n = require('../src/shared/i18n');
const { loadSettings, saveSettings } = require('../src/main/settings-store');
const { systemLocales } = require('../src/main/language');
const queueManager = require('../src/main/queue-manager');
const dictionaries = Object.fromEntries(i18n.CODES.map((code) => [code, require(`../src/shared/locales/${code}.js`)]));

const SHOTS = process.env.COMPACTA_SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getWin = () => BrowserWindow.getAllWindows()[0];
const js = (code) => getWin().webContents.executeJavaScript(code, true);
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function waitFor(fn, timeoutMs = 8000, stepMs = 50) {
  const start = Date.now();
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = false; }
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timeout esperando una condicion');
    await sleep(stepMs);
  }
}

async function test(name, fn) {
  try {
    await js(`document.getElementById('settingsOverlay').classList.add('hidden')`);
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL  ${name}\n        -> ${err && err.message}`);
  }
}

async function shot(name) {
  if (!SHOTS) return;
  const image = await getWin().webContents.capturePage();
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG());
}

/** Elige un idioma en el selector de Ajustes, igual que la persona (cambia el valor y avisa del cambio). */
async function chooseLanguage(code) {
  await js(`(() => { const s = document.getElementById('languageSelect'); s.value = ${JSON.stringify(code || '')}; s.dispatchEvent(new Event('change', { bubbles: true })); return 0; })()`);
  const expected = code || i18n.resolveLanguage(null, systemLocales());
  await waitFor(() => js(`document.documentElement.lang === ${JSON.stringify(expected)}`), 5000);
  await sleep(150);
}

/** Textos recortados o que se salen: elementos con overflow oculto/automatico cuyo contenido no cabe, y desborde horizontal de la pagina. */
function overflowProbe() {
  return `(() => {
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('.hidden') || !el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
      const style = getComputedStyle(el);
      if (!el.textContent.trim() || el.children.length > 0 && el.tagName !== 'BUTTON') continue;
      const clipped = style.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1;
      const wide = el.getBoundingClientRect().right > window.innerWidth + 1 || el.getBoundingClientRect().left < -1;
      if ((clipped && style.textOverflow !== 'ellipsis') || wide) bad.push((el.id || el.className || el.tagName) + ': ' + el.textContent.trim().slice(0, 40));
    }
    const page = document.documentElement.scrollWidth > window.innerWidth + 1 ? ['PAGINA desborda ' + document.documentElement.scrollWidth + ' > ' + window.innerWidth] : [];
    return [...page, ...bad];
  })()`;
}

async function run() {
  await waitFor(() => getWin() && !getWin().webContents.isLoading(), 20000);
  await waitFor(() => js('!!(window.api && window.I18n && window.QueueView && document.getElementById("languageSelect"))'), 10000);
  console.log('\nApp abierta. Pruebas de idiomas:\n');

  await test('Sin idioma elegido, la app usa el del sistema (o inglés si no lo soporta) y lo declara en <html>', async () => {
    saveSettings({ language: null });
    await js(`window.api.saveSettings({ language: null })`);
    await chooseLanguage(null);
    const expected = i18n.resolveLanguage(null, systemLocales());
    assert((await js('document.documentElement.lang')) === expected, `html lang debía ser ${expected}`);
    assert((await js('document.getElementById("dropzoneTitle").textContent')) === dictionaries[expected]['dropzone.title'], 'el título debe salir en ese idioma');
  });

  await test('El selector ofrece «Automático» y los 6 idiomas, cada uno con su propio nombre', async () => {
    const options = await js(`[...document.getElementById('languageSelect').options].map((o) => o.textContent)`);
    assert(options.length === 7, `7 opciones, hay ${options.length}`);
    for (const name of ['Español', 'English', 'Deutsch', 'Italiano', 'Tiếng Việt', 'العربية']) assert(options.includes(name), `falta ${name}`);
  });

  // Una foto ya optimizada: su fila muestra un motivo traducible, para ver el cambio en vivo.
  const photoDir = path.join(tmpRoot, 'src');
  fs.mkdirSync(photoDir, { recursive: true });
  await sharp({ create: { width: 40, height: 40, channels: 3, background: '#335577' } }).jpeg({ quality: 40 }).toFile(path.join(photoDir, 'azul.jpg'));
  await chooseLanguage('it');
  await js(`window.api.importFiles(${JSON.stringify([path.join(photoDir, 'azul.jpg')])})`);
  await waitFor(() => { const s = queueManager.getSnapshot(); return s.jobs.length === 1 && s.jobs[0].status === 'done'; }, 15000);

  for (const code of i18n.CODES) {
    await test(`${code}: el cambio es inmediato y completo (textos fijos, fila de la cola, pie, dirección) y el proceso principal también lo adopta`, async () => {
      await chooseLanguage(code);
      const d = dictionaries[code];
      const read = (id) => js(`document.getElementById(${JSON.stringify(id)}).textContent.trim()`);
      assert((await js('document.documentElement.lang')) === code, 'lang');
      assert((await js('document.documentElement.dir')) === (code === 'ar' ? 'rtl' : 'ltr'), 'dir');
      assert((await read('dropzoneTitle')) === d['dropzone.title'], 'título de la zona de arrastre');
      assert((await js(`document.querySelector('.queue-header h2, #queueTitle, [data-i18n="queue.title"]').textContent.trim()`)) === d['queue.title'], 'título de la cola');
      assert((await read('chooseFilesBtn')) === d['dropzone.chooseFiles'], 'botón de elegir archivos');
      assert((await js(`document.querySelector('#settingsOverlay h2').textContent.trim()`)) === d['settings.title'], 'título de Ajustes');
      assert((await js(`document.getElementById('settingsBtn').title`)) === d['settings.open'], 'ayuda del botón de Ajustes');
      assert((await read('dropzoneSubtitle')).includes(code === 'ar' ? 'Ctrl+V' : 'Ctrl+V'), 'el atajo de pegar aparece en el subtítulo');
      assert((await js(`document.getElementById('savedTotal').textContent`)).length > 0, 'ahorrado total');
      const rowText = await js(`document.querySelector('#queueList li').textContent.replace(/\\s+/g, ' ')`);
      const reasons = ['skip.already', 'skip.noGain'].map((k) => d[k]);
      const savedWord = d['queue.noChange'];
      assert(rowText.includes(savedWord) || /-\d+%/.test(rowText), `la fila de la cola debe estar en ${code}: ${rowText}`);
      if (rowText.includes(savedWord)) assert(reasons.some((r) => rowText.includes(r)), `el motivo de «sin cambios» debe estar en ${code}: ${rowText}`);
      assert(loadSettings().language === code, 'el ajuste se guardó');
      assert(i18n.getLanguage() === code, 'el proceso principal habla el mismo idioma');
      await shot(`${code}-principal`);
    });

    await test(`${code}: ningún texto se sale ni queda recortado (ventana principal y Ajustes)`, async () => {
      await chooseLanguage(code);
      let bad = await js(overflowProbe());
      assert(bad.length === 0, `en la ventana principal: ${JSON.stringify(bad.slice(0, 5))}`);
      await js(`document.getElementById('settingsBtn').click()`);
      await sleep(250);
      bad = await js(overflowProbe());
      await shot(`${code}-ajustes`);
      assert(bad.length === 0, `en Ajustes: ${JSON.stringify(bad.slice(0, 5))}`);
    });
  }

  await test('Árabe: la ventana va de derecha a izquierda y el interruptor se desplaza hacia el lado correcto (y vuelve en los demás)', async () => {
    await js(`document.getElementById('settingsBtn').click()`); // el interruptor solo se calcula con Ajustes visible
    await sleep(250);
    const thumbShift = async () => {
      await js(`(() => { const c = [...document.querySelectorAll('.switch input')][0]; c.checked = true; return 0; })()`);
      await sleep(500); // termina la animacion del interruptor
      return js(`(() => { const t = document.querySelector('.switch input').closest('.switch').querySelector('.switch__thumb'); return new DOMMatrix(getComputedStyle(t).transform).m41; })()`);
    };
    await chooseLanguage('ar');
    const rtlShift = await thumbShift();
    const rtlLayout = await js(`(() => { const t = document.querySelector('.brand, header h1, h1'); return t ? getComputedStyle(t).direction : 'ltr'; })()`);
    await chooseLanguage('en');
    const ltrShift = await thumbShift();
    assert(rtlLayout === 'rtl', `el texto debía ir de derecha a izquierda (${rtlLayout})`);
    assert(rtlShift < 0, `en árabe el interruptor se mueve hacia la izquierda (${rtlShift})`);
    assert(ltrShift > 0, `en el resto, hacia la derecha (${ltrShift})`);
  });

  await test('La comparación antes/después sigue siendo «izquierda = original» también en árabe (la barra no se invierte)', async () => {
    await chooseLanguage('ar');
    const dirs = await js(`['.preview-stage-wrap', '#previewSlider'].map((s) => getComputedStyle(document.querySelector(s)).direction)`);
    assert(dirs.every((d) => d === 'ltr'), `el escenario y la barra deben quedarse de izquierda a derecha: ${dirs}`);
  });

  await test('Volver a «Automático» deja el idioma del sistema y borra la elección guardada', async () => {
    await chooseLanguage(null);
    assert(loadSettings().language === null, 'el ajuste vuelve a automático');
    const state = await js('window.api.getLanguage()');
    assert(state.setting === null && state.language === i18n.resolveLanguage(null, systemLocales()), JSON.stringify(state));
  });
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.log('ERROR FATAL EN LA PRUEBA:', err && err.stack);
    results.push({ name: 'ejecucion', ok: false, err });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} pruebas de idiomas correctas`);
  clearTimeout(watchdog);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  app.exit(failed.length === 0 ? 0 : 1);
});
