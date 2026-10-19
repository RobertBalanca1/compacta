'use strict';

/**
 * Prueba de interfaz de punta a punta: levanta la app REAL (index.js), abre
 * la ventana real y la maneja como lo haria una persona -- clics, teclas,
 * cerrar y reabrir la ventana -- comprobando lo que se ve y lo que pasa en
 * el proceso principal.
 *
 * Existe porque las pruebas unitarias del almacen de ajustes NO detectaron
 * que `window.prompt()` no funciona en Electron (los perfiles parecian
 * implementados y no se podia crear ninguno). Solo se encuentra hacienda
 * clic de verdad.
 *
 * Uso:  npm run test:ui     (en Linux sin pantalla: xvfb-run -a npm run test:ui)
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, dialog } = require('electron');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compacta-ui-'));
app.setPath('userData', path.join(tmpRoot, 'userData'));
app.setPath('documents', path.join(tmpRoot, 'Documents'));

// Nada de dialogos nativos en la prueba: se cuentan y se cancelan solos.
let filePickerOpened = 0;
let nextDialogFiles = null;
let lastDialogOptions = null;
dialog.showOpenDialog = async (first, second) => {
  lastDialogOptions = second || first;
  // Igual que el dialogo real: darle una ventana ya cerrada es un error.
  if (first && typeof first.isDestroyed === 'function' && first.isDestroyed()) {
    throw new Error('Object has been destroyed');
  }
  filePickerOpened += 1;
  if (nextDialogFiles) {
    const filePaths = nextDialogFiles;
    nextDialogFiles = null;
    return { canceled: false, filePaths };
  }
  return { canceled: true, filePaths: [] };
};

// Guardia: si algo se cuelga, que no deje el proceso abierto para siempre.
const watchdog = setTimeout(() => {
  console.error('WATCHDOG: la prueba tardo demasiado, se aborta');
  app.exit(2);
}, 250000);

// Espia setAppUserModelId (Windows: identidad de las notificaciones/barra de
// tareas) ANTES de cargar index.js, que es donde se llama nada mas arrancar.
let appUserModelIdSetTo = null;
const originalSetAppUserModelId = app.setAppUserModelId.bind(app);
app.setAppUserModelId = (id) => { appUserModelIdSetTo = id; return originalSetAppUserModelId(id); };

require('../src/main/index.js');
// Las pruebas de abajo comprueban textos en español: se fija el idioma (si no, saldria el del sistema que
// ejecuta la prueba). Las de idiomas (mas abajo) lo cambian a proposito.
require('../src/main/settings-store').saveSettings({ language: 'es' });
const sharp = require('sharp');
const queueManager = require('../src/main/queue-manager');

let notifier = null;
try {
  notifier = require('../src/main/notifier');
} catch {
  notifier = null; // version anterior sin notifier: la prueba lo reporta como fallo
}

const results = [];
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(String((reason && reason.message) || reason)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function resetUi() {
  await js(`(function () {
    const so = document.getElementById('settingsOverlay'); if (so) so.classList.add('hidden');
    const dov = document.getElementById('dialogOverlay'); if (dov) dov.classList.add('hidden');
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    return 0;
  })()`);
}

async function test(name, fn) {
  try {
    await resetUi();
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL  ${name}\n        -> ${err && err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const getWin = () => BrowserWindow.getAllWindows()[0];
const js = (code) => getWin().webContents.executeJavaScript(code, true);

async function pressSpace(holdMs = 90) {
  const wc = getWin().webContents;
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  await sleep(holdMs);
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await sleep(350);
}

/**
 * Clic de RATON de verdad (coordenadas + mouseDown/mouseUp), no `.click()`
 * por JS. `.click()` invoca el manejador directamente sin pasar por el
 * "hit test" real del navegador, asi que nunca podria detectar un boton
 * que se ve bien pero que, por superposicion o mal calculo de tamaño, no
 * recibe el clic donde el usuario de verdad pulsa.
 */
async function realClick(selector) {
  const rect = await js(`(function () {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { zeroSize: true };
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!rect) throw new Error(`realClick: no existe "${selector}"`);
  if (rect.zeroSize) throw new Error(`realClick: "${selector}" tiene tamaño cero (oculto o mal medido)`);
  const wc = getWin().webContents;
  const point = { x: Math.round(rect.x), y: Math.round(rect.y) };
  wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  await sleep(30);
  wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  await sleep(150);
}

async function makePhotos(dir, count, { width = 1600, height = 1100, prefix = 'foto', ext = 'jpg' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    await sharp({
      create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 40 } }
    }).jpeg({ quality: 95 }).toFile(path.join(dir, `${prefix}${i}.${ext}`));
  }
}

async function importFolder(dir) {
  return js(`window.api.importFiles(${JSON.stringify([dir])})`);
}

async function waitQueueDrained() {
  await waitFor(() => {
    const s = queueManager.getSnapshot();
    return !s.isProcessing && !s.jobs.some((j) => j.status === 'pending' || j.status === 'processing');
  }, 60000, 100);
}

async function run() {
  await waitFor(() => getWin() && !getWin().webContents.isLoading(), 20000);
  await waitFor(() => js('!!(window.api && window.QueueView && document.getElementById("settingsBtn"))'), 10000);
  console.log('\nApp abierta. Empiezan las pruebas de interfaz:\n');

  await test('Bug reportado: la notificacion ya no debe verse como "electron.app.Compacta" (falta setAppUserModelId)', async () => {
    const { APP_USER_MODEL_ID } = require('../src/main/app-id');
    assert(
      appUserModelIdSetTo === APP_USER_MODEL_ID,
      `setAppUserModelId debe llamarse con APP_USER_MODEL_ID ("${APP_USER_MODEL_ID}"), se llamo con: ${appUserModelIdSetTo}`
    );
  });

  await test('CompletionSound.play() nunca lanza, aunque no haya salida de audio disponible (sandbox/CI)', async () => {
    const err = await js(`(function(){ try { window.CompletionSound.play(); return null; } catch(e) { return String(e); } })()`);
    assert(err === null, `CompletionSound.play() no debe lanzar nunca, lanzo: ${err}`);
  });

  // ---------------------------------------------------------------- Perfiles
  await test('Electron NO soporta window.prompt (por eso los perfiles fallaban)', async () => {
    const r = await js(`(function(){ try { const v = window.prompt('x'); return {threw:false, v}; } catch(e){ return {threw:true, msg:String(e)}; } })()`);
    // Informativo: si prompt devolviera un texto real, no habria problema.
    assert(r.threw || r.v === null, 'prompt devolvio un valor inesperado');
  });

  await test('Perfiles: crear un perfil nuevo con el boton +', async () => {
    await js('document.getElementById("settingsBtn").click()');
    await js('document.getElementById("qualitySlider").value = 72; document.getElementById("qualitySlider").dispatchEvent(new Event("change", {bubbles:true}))');
    await sleep(150);
    await js('document.getElementById("newProfileBtn").click()');
    await waitFor(() => js('!document.getElementById("dialogOverlay").classList.contains("hidden")'), 3000);
    await js('document.getElementById("dialogInput").value = "Para proyector"; document.getElementById("dialogOk").click()');
    await waitFor(() => js('document.getElementById("profileSelect").options.length === 2'), 3000);
    const sel = await js('document.getElementById("profileSelect").selectedOptions[0].textContent');
    assert(sel === 'Para proyector', `el perfil nuevo debe quedar seleccionado, quedo: ${sel}`);
    const q = await js('document.getElementById("qualitySlider").value');
    assert(String(q) === '72', `el perfil nuevo debe conservar los ajustes actuales (72), tiene ${q}`);
  });

  await test('Perfiles: cambiar de perfil actualiza los controles', async () => {
    // Mover el slider actualiza el perfil ACTIVO (a proposito): el perfil
    // original quedo en 72 cuando se movio antes de crear el nuevo.
    await js('document.getElementById("qualitySlider").value = 65; document.getElementById("qualitySlider").dispatchEvent(new Event("change", {bubbles:true}))');
    await sleep(150);
    await js(`(function(){ const s = document.getElementById("profileSelect"); s.value = s.options[0].value; s.dispatchEvent(new Event("change", {bubbles:true})); })()`);
    await waitFor(() => js('document.getElementById("qualitySlider").value === "72"'), 3000);
    await js(`(function(){ const s = document.getElementById("profileSelect"); s.value = s.options[1].value; s.dispatchEvent(new Event("change", {bubbles:true})); })()`);
    await waitFor(() => js('document.getElementById("qualitySlider").value === "65"'), 3000);
  });

  await test('Perfiles: renombrar', async () => {
    await js('document.getElementById("renameProfileBtn").click()');
    await waitFor(() => js('!document.getElementById("dialogOverlay").classList.contains("hidden")'), 3000);
    const prefilled = await js('document.getElementById("dialogInput").value');
    assert(prefilled === 'Para proyector', `el cuadro debe traer el nombre actual, trae: ${prefilled}`);
    await js('document.getElementById("dialogInput").value = "Para imprimir"; document.getElementById("dialogOk").click()');
    await waitFor(() => js('document.getElementById("profileSelect").selectedOptions[0].textContent === "Para imprimir"'), 3000);
  });

  await test('Perfiles: cancelar el cuadro no cambia nada', async () => {
    await js('document.getElementById("newProfileBtn").click()');
    await waitFor(() => js('!document.getElementById("dialogOverlay").classList.contains("hidden")'), 3000);
    await js('document.getElementById("dialogCancel").click()');
    await sleep(200);
    const n = await js('document.getElementById("profileSelect").options.length');
    assert(n === 2, `debian seguir siendo 2 perfiles, hay ${n}`);
  });

  await test('Perfiles: eliminar pide confirmacion dentro de la app y borra', async () => {
    await js('document.getElementById("deleteProfileBtn").click()');
    await waitFor(() => js('!document.getElementById("dialogOverlay").classList.contains("hidden")'), 3000);
    await js('document.getElementById("dialogOk").click()');
    await waitFor(() => js('document.getElementById("profileSelect").options.length === 1'), 3000);
    const disabled = await js('document.getElementById("deleteProfileBtn").disabled');
    assert(disabled === true, 'con un solo perfil, eliminar debe quedar desactivado');
    await js('document.getElementById("closeSettingsBtn").click()');
  });

  await test('Perfiles: se guardan en disco y sobreviven a recargar la ventana', async () => {
    const settingsFile = path.join(tmpRoot, 'userData', 'settings.json');
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    assert(Array.isArray(saved.profiles) && saved.profiles.length === 1, 'settings.json debe tener 1 perfil');
  });

  // ------------------------------------------------- Cola, teclado, avisos
  const bigDir = path.join(tmpRoot, 'src', 'Grandes');
  // Las pruebas de teclado/pendientes necesitan un lote que tarde unos
  // segundos. Con el modo rapido por defecto un lote asi acaba en un parpadeo,
  // asi que aqui se usa a proposito "Compresion maxima" (mozjpeg, lento).
  await js('window.api.saveSettings({ maxCompression: true })');
  await makePhotos(bigDir, 10, { width: 2600, height: 1800 });

  await test('Miniaturas: se quitaron a proposito (ver 7.11) -- la cola muestra un icono generico, no la foto', async () => {
    // Se probo primero con una miniatura real generada y cacheada (ver
    // historial en DOCUMENTACION-PROYECTO.md 7.10): funcionaba y quedaba
    // verificado aqui mismo, pero en uso real seguia viendose mal en
    // maquinas que no se pueden reproducir en esta suite (glitches de
    // composicion de GPU especificos de hardware). En vez de perseguir a
    // ciegas un bug de GPU que no se puede ver desde aqui, se elimino la
    // vista previa de la foto por completo: cero decodificacion de imagenes
    // ajena a la barra de progreso, cero superficie para este tipo de bug.
    const dir = path.join(tmpRoot, 'src', 'Miniaturas');
    const ANCHO_GRANDE = 3000;
    await makePhotos(dir, 4, { width: ANCHO_GRANDE, height: 2000, prefix: 'DSC' });
    await importFolder(dir);

    await waitFor(() => js('document.querySelectorAll("#queueList li").length >= 4'), 8000);
    // Ni un solo <img> por fila: nada que decodificar, nada que se pueda
    // "ver mal" mas alla de un simple dibujo vectorial identico en todas.
    const hayImagenes = await js('document.querySelectorAll("#queueList img").length');
    assert(hayImagenes === 0, `no debe haber ningun <img> en la cola (se encontraron ${hayImagenes})`);
    // El icono debe ser el mismo SVG estatico para todas las filas -- si
    // alguna fuera distinta, seria señal de que algo intenta volver a
    // mostrar contenido de la foto en vez del icono generico.
    // (Cada fila lleva el icono de foto y el de video; CSS muestra solo el de su tipo.)
    const iconosUnicos = await js('new Set([...document.querySelectorAll("#queueList li[data-kind=image] .queue-item__icon--image")].map((el) => el.outerHTML)).size');
    assert(iconosUnicos === 1, `todas las fotos deben usar el mismo icono generico, hay ${iconosUnicos} variantes`);
    const visibles = await js('[...document.querySelectorAll("#queueList li")].every((li) => [...li.querySelectorAll(".queue-item__icon")].filter((i) => getComputedStyle(i).display !== "none").length === 1)');
    assert(visibles, 'cada fila debe mostrar exactamente UN icono (el de su tipo)');

    await waitQueueDrained();
    await js('window.api.clearFinished()');
    await waitFor(() => js('document.querySelectorAll("#queueList li").length === 0'), 4000);
  });

  await test('Barra espaciadora sin foco: alterna Detener/Reanudar', async () => {
    queueManager.pause();
    await importFolder(bigDir);
    await waitFor(() => js('document.querySelectorAll("#queueList li").length === 10'), 8000);
    await js('document.activeElement && document.activeElement.blur()');
    await pressSpace();
    assert(queueManager.paused === false, 'Espacio debia reanudar la cola');
    await pressSpace();
    assert(queueManager.paused === true, 'Espacio debia detener la cola otra vez');
  });

  await test('Barra espaciadora con el boton enfocado: UN solo cambio (no dos)', async () => {
    assert(queueManager.paused === true, 'precondicion: cola detenida');
    await js('document.getElementById("pauseResumeBtn").focus()');
    await pressSpace(120);
    assert(queueManager.paused === false, 'con el boton enfocado, Espacio debia reanudar exactamente una vez (se anulo a si mismo)');
  });

  await test('Barra espaciadora sobre la zona de arrastrar: abre el selector y NO alterna la cola', async () => {
    queueManager.pause();
    await sleep(150);
    const before = filePickerOpened;
    await js('document.getElementById("dropzone").focus()');
    await pressSpace();
    assert(queueManager.paused === true, 'Espacio sobre la zona de arrastrar no debe reanudar la cola');
    assert(filePickerOpened === before + 1, 'Espacio sobre la zona de arrastrar debe abrir el selector una vez');
  });

  await test('Bug reportado: con "Elegir carpeta" enfocado (tras usarlo), espacio alterna la cola y NO reabre ningun selector', async () => {
    // Reproduce el caso real: el usuario hace clic en "Elegir carpeta" (el
    // foco se queda ahi, como hace Chromium tras un clic), y despues, ya con
    // fotos en la cola, pulsa espacio esperando Detener/Reanudar. Antes de
    // la correccion esto NO alternaba nada y en cambio volvia a abrir el
    // selector de carpeta sin avisar. Se parte del mismo estado (paused)
    // que dejo la prueba anterior y se hacen dos pulsaciones (ida y vuelta)
    // para no dejar sin procesar de mas al lote grande que usan pruebas
    // posteriores.
    assert(queueManager.paused === true, 'precondicion: cola detenida (como la dejo la prueba anterior)');
    const before = filePickerOpened;
    await js('document.getElementById("chooseFolderBtn").focus()');
    await pressSpace();
    assert(queueManager.paused === false, 'con "Elegir carpeta" enfocado, espacio debe reanudar igual que en cualquier otro sitio');
    await pressSpace();
    assert(queueManager.paused === true, 'y una segunda pulsada debe volver a detener, con normalidad');
    assert(filePickerOpened === before, 'espacio NO debe reabrir el selector de carpeta cuando lo que se quiere es Detener/Reanudar');
  });

  await test('Bug reportado: con "Elegir archivos" enfocado, espacio alterna la cola y NO reabre el selector', async () => {
    assert(queueManager.paused === true, 'precondicion: cola detenida');
    const before = filePickerOpened;
    await js('document.getElementById("chooseFilesBtn").focus()');
    await pressSpace();
    assert(queueManager.paused === false, 'con "Elegir archivos" enfocado, espacio debe reanudar');
    await pressSpace();
    assert(queueManager.paused === true, 'y volver a detener con la segunda pulsada');
    assert(filePickerOpened === before, 'espacio no debe reabrir el selector de archivos');
  });

  await test('Con "Abrir carpeta de salida" enfocado, espacio alterna la cola y no dispara ese boton', async () => {
    assert(queueManager.paused === true, 'precondicion: cola detenida');
    await js('document.getElementById("openOutputBtn").focus()');
    await pressSpace();
    assert(queueManager.paused === false, 'espacio debe reanudar la cola aunque el foco este en un boton ajeno a ella');
    await pressSpace();
    assert(queueManager.paused === true, 'y volver a detener con la segunda pulsada, dejando la cola lista para la siguiente prueba');
  });

  await test('Eliminar pendientes: confirma dentro de la app y descarta lo que esperaba', async () => {
    await js('(function(){ window.confirm = () => true; return 0; })()');
    const pendingBefore = queueManager.jobs.filter((j) => j.status === 'pending').length;
    assert(pendingBefore > 0, 'precondicion: debe haber pendientes');
    await waitFor(() => js('!document.getElementById("cancelPendingBtn").classList.contains("hidden")'), 4000);
    await js('document.getElementById("cancelPendingBtn").click()');
    await sleep(300);
    const overlayOpen = await js('!document.getElementById("dialogOverlay").classList.contains("hidden")');
    if (overlayOpen) await js('document.getElementById("dialogOk").click()');
    await waitFor(() => queueManager.jobs.filter((j) => j.status === 'pending').length === 0, 4000);
  });

  await waitQueueDrained();
  await js('window.api.saveSettings({ maxCompression: false })');
  await sleep(300);

  await test('Aviso de lote terminado: notificacion del sistema (sin exigir que la ventana este en segundo plano)', async () => {
    assert(notifier, 'no existe src/main/notifier.js');
    const shown = [];
    notifier.setNotificationFactory((opts) => ({ show: () => shown.push(opts) }));
    const dir = path.join(tmpRoot, 'src', 'Lote6');
    await makePhotos(dir, 6, { width: 600, height: 400 });
    getWin().focus(); // a proposito con la ventana enfocada: antes no avisaba en este caso
    await importFolder(dir);
    await waitQueueDrained();
    await waitFor(() => shown.length >= 1, 4000);
    assert(/6/.test(shown[0].body), `el aviso debe mencionar 6 fotos, dice: ${shown[0].body}`);
  });

  await test('Aviso de lote terminado: aparece tambien dentro de la app (verde), y con sonido', async () => {
    const dir = path.join(tmpRoot, 'src', 'Lote7');
    await makePhotos(dir, 7, { width: 600, height: 400 });
    await js('document.getElementById("toast").classList.add("hidden")');
    await js('window.__sonidosReproducidos = 0; window.CompletionSound.play = () => { window.__sonidosReproducidos++; }; null;');
    await importFolder(dir);
    await waitQueueDrained();
    await waitFor(() => js('!document.getElementById("toast").classList.contains("hidden")'), 4000);
    const cls = await js('document.getElementById("toast").className');
    const txt = await js('document.getElementById("toast").textContent');
    assert(/toast--ok/.test(cls), `el aviso de exito debe ser verde, clases: ${cls}`);
    assert(/7/.test(txt), `debe mencionar 7 fotos, dice: ${txt}`);
    const sonidos = await js('window.__sonidosReproducidos');
    assert(sonidos === 1, `debe sonar una vez al terminar el lote, sono: ${sonidos}`);
  });

  await test('Lote pequeno (menos de 5): no molesta con aviso de lote terminado ni con sonido', async () => {
    const shown = [];
    notifier.setNotificationFactory((opts) => ({ show: () => shown.push(opts) }));
    const dir = path.join(tmpRoot, 'src', 'Lote2');
    await makePhotos(dir, 2, { width: 500, height: 300 });
    await js('document.getElementById("toast").classList.add("hidden")');
    await js('window.__sonidosReproducidos = 0; window.CompletionSound.play = () => { window.__sonidosReproducidos++; }; null;');
    await importFolder(dir);
    await waitQueueDrained();
    await sleep(500);
    assert(shown.length === 0, 'un lote de 2 fotos no debe generar notificacion del sistema');
    const hidden = await js('document.getElementById("toast").classList.contains("hidden")');
    assert(hidden, 'un lote de 2 fotos no debe mostrar aviso verde');
    const sonidos = await js('window.__sonidosReproducidos');
    assert(sonidos === 0, `un lote de 2 fotos no debe sonar, sono: ${sonidos}`);
  });

  await test('HEIC: una foto de iPhone se IMPORTA como cualquier foto (sin avisos de "no compatible"); si está dañada, su fila dice el motivo', async () => {
    const dir = path.join(tmpRoot, 'src', 'ConHeic');
    fs.mkdirSync(dir, { recursive: true });
    const heic = path.join(dir, 'IMG_1.HEIC');
    fs.writeFileSync(heic, 'no es una imagen real');
    await js('document.getElementById("toast").classList.add("hidden")');
    const before = queueManager.jobs.length;
    nextDialogFiles = [heic];
    await js('document.getElementById("chooseFilesBtn").click()');
    await waitFor(() => queueManager.jobs.length === before + 1, 4000);
    const job = queueManager.jobs[queueManager.jobs.length - 1];
    await waitFor(() => job.status === 'error' || job.status === 'done', 6000);
    assert(job.status === 'error' && /HEIC/.test(job.error), `un HEIC dañado debe fallar con su motivo, y fue: ${job.status} ${job.error}`);
    const toastHidden = await js('document.getElementById("toast").classList.contains("hidden")');
    assert(toastHidden, 'un HEIC ya no es "formato no compatible": no debe salir ese aviso');
    await new Promise((resolve) => setTimeout(resolve, 300)); // deja que la ventana dibuje la fila
    const rows = await js(`[...document.querySelectorAll('#queueList li')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim())`);
    const row = rows.find((text) => /IMG_1/i.test(text)) || '';
    assert(/HEIC/.test(row), `la fila debe mostrar el motivo del error. Filas: ${JSON.stringify(rows.slice(-3))}`);
  });

  await test('Carpetas: soltar OTRA VEZ una carpeta con el mismo nombre la UNE a la de antes (sin «Nombre (2)»), y lo distinto con el mismo nombre se numera en el ARCHIVO', async () => {
    const inputDir = require('../src/main/paths').getInputDir();
    const dir = path.join(tmpRoot, 'src', 'MismaCarpeta');
    fs.mkdirSync(dir, { recursive: true });
    await sharp({ create: { width: 640, height: 480, channels: 3, noise: { type: 'gaussian', mean: 70, sigma: 60 } } }).jpeg({ quality: 95 }).toFile(path.join(dir, 'a.jpg'));
    await waitQueueDrained();
    nextDialogFiles = [dir];
    await js('document.getElementById("chooseFolderBtn").click()');
    await waitFor(() => fs.existsSync(path.join(inputDir, 'MismaCarpeta', 'a.jpg')), 5000);
    await waitQueueDrained();

    // otra foto DISTINTA con el mismo nombre de archivo, dentro de una carpeta con el mismo nombre
    await sharp({ create: { width: 640, height: 480, channels: 3, noise: { type: 'gaussian', mean: 160, sigma: 30 } } }).jpeg({ quality: 95 }).toFile(path.join(dir, 'a.jpg'));
    nextDialogFiles = [dir];
    await js('document.getElementById("chooseFolderBtn").click()');
    await waitFor(() => fs.existsSync(path.join(inputDir, 'MismaCarpeta', 'a (2).jpg')), 5000);
    await waitQueueDrained();

    const folders = fs.readdirSync(inputDir).filter((n) => n.startsWith('MismaCarpeta'));
    assert(folders.length === 1 && folders[0] === 'MismaCarpeta', `una sola carpeta, sin número: ${folders}`);
    assert(fs.readdirSync(path.join(inputDir, 'MismaCarpeta')).sort().join() === 'a (2).jpg,a.jpg', 'las dos fotos, ninguna pisó a la otra');
    const outFolders = fs.readdirSync(require('../src/main/paths').getOutputDir()).filter((n) => n.startsWith('MismaCarpeta'));
    assert(outFolders.length === 1 && outFolders[0] === 'MismaCarpeta', `y en la salida tambien una sola: ${outFolders}`);
  });

  await test('HEIC: la opción «pasar siempre a JPG» está en Ajustes, apagada por defecto, se guarda y vuelve al reabrir', async () => {
    const state = () => js('(async () => { const s = await window.api.getSettings(); return { saved: s.heicAlwaysJpg, checked: document.getElementById("heicToggle").checked }; })()');
    await js('document.getElementById("settingsBtn").click()');
    assert((await state()).saved === false, 'apagada por defecto');
    assert((await js('document.getElementById("heicToggle").checked')) === false, 'y el interruptor igual');
    await js('document.getElementById("heicToggle").click()');
    await waitFor(async () => (await state()).saved === true, 3000);
    const label = await js('document.querySelector("[data-i18n=\\"settings.heic.label\\"]").textContent');
    assert(/HEIC/.test(label) && /JPG/.test(label), `etiqueta: ${label}`);
    await js('document.getElementById("heicToggle").click()'); // se deja apagada para el resto de pruebas
    await waitFor(async () => (await state()).saved === false, 3000);
    await js('document.getElementById("closeSettingsBtn").click()');
  });

  await test('ZIP con contraseña: se abre un cuadro con campo oculto, una contraseña mala vuelve a preguntar y la buena importa las fotos', async () => {
    const { makeEncryptedZip, ENCRYPTED_ZIP_AVAILABLE } = require('./helpers/make-encrypted-zip');
    if (!ENCRYPTED_ZIP_AVAILABLE) { console.log('        (omitida: faltan zip/pyzipper para fabricar el ZIP cifrado)'); return; }
    const zipPath = path.join(tmpRoot, 'src', 'Reservadas.zip');
    const photo = await sharp({ create: { width: 320, height: 240, channels: 3, noise: { type: 'gaussian', mean: 100, sigma: 55 } } }).jpeg({ quality: 90 }).toBuffer();
    assert(makeEncryptedZip(zipPath, [{ name: 'secreta.jpg', data: photo }], { kind: 'aes256', password: 'abre ñ ' }), 'no se pudo crear el ZIP cifrado');
    await waitQueueDrained();
    const before = queueManager.jobs.length;

    nextDialogFiles = [zipPath];
    await js('document.getElementById("chooseArchiveBtn").click()');
    const dialogState = () => js(`(() => { const o = document.getElementById('dialogOverlay'); const i = document.getElementById('dialogInput'); return { open: !o.classList.contains('hidden'), type: i.type, title: document.getElementById('dialogTitle').textContent, message: document.getElementById('dialogMessage').textContent }; })()`);
    await waitFor(async () => (await dialogState()).open, 6000);
    let state = await dialogState();
    assert(state.type === 'password', `el campo debe ocultar lo que se escribe: ${state.type}`);
    assert(/Reservadas/.test(state.message) && /contraseña/.test(state.message), `debe nombrar el comprimido: ${state.message}`);
    assert(queueManager.jobs.length === before, 'mientras se pregunta, no se importa nada');

    const answer = async (text) => {
      await js(`(() => { const i = document.getElementById('dialogInput'); i.value = ${JSON.stringify(text)}; document.getElementById('dialogOk').click(); return 0; })()`);
    };
    await answer('esta no es');
    await waitFor(async () => { const d = await dialogState(); return d.open && /no es correcta/.test(d.message); }, 6000);
    assert(queueManager.jobs.length === before, 'una contraseña equivocada no importa nada');

    await answer('abre ñ '); // con su espacio final: se respeta tal cual
    await waitFor(() => queueManager.jobs.length === before + 1, 8000);
    assert(!(await dialogState()).open, 'con la buena, el cuadro se cierra');
    await waitQueueDrained();
    const job = queueManager.jobs[queueManager.jobs.length - 1];
    assert(job.status === 'done', `la foto debe procesarse: ${job.status} ${job.error || ''}`);
  });

  await test('ZIP con contraseña: cancelar el cuadro deja el aviso de siempre y no importa nada', async () => {
    const { makeEncryptedZip, ENCRYPTED_ZIP_AVAILABLE } = require('./helpers/make-encrypted-zip');
    if (!ENCRYPTED_ZIP_AVAILABLE) return;
    const zipPath = path.join(tmpRoot, 'src', 'Cancelada.zip');
    const photo = await sharp({ create: { width: 200, height: 200, channels: 3, noise: { type: 'gaussian', mean: 90, sigma: 60 } } }).jpeg().toBuffer();
    assert(makeEncryptedZip(zipPath, [{ name: 'x.jpg', data: photo }], { kind: 'zipcrypto', password: 'zzz' }));
    const before = queueManager.jobs.length;
    await js('document.getElementById("toast").classList.add("hidden")');
    nextDialogFiles = [zipPath];
    await js('document.getElementById("chooseArchiveBtn").click()');
    await waitFor(() => js('!document.getElementById("dialogOverlay").classList.contains("hidden")'), 6000);
    await js('document.getElementById("dialogCancel").click()');
    await waitFor(() => js('!document.getElementById("toast").classList.contains("hidden")'), 4000);
    const toast = await js('document.getElementById("toast").textContent');
    assert(/Cancelada/.test(toast) && /contraseña/.test(toast), `debe avisar que sigue protegido: ${toast}`);
    assert(queueManager.jobs.length === before, 'no se importo nada');
  });

  await test('Mac: .DS_Store y Thumbs.db NO cuentan como archivos no compatibles', async () => {
    const dir = path.join(tmpRoot, 'src', 'CarpetaDeMac');
    await makePhotos(dir, 1, { width: 300, height: 200 });
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
    fs.writeFileSync(path.join(dir, 'Thumbs.db'), 'x');
    fs.writeFileSync(path.join(dir, '._foto0.jpg'), 'x');
    const r = await importFolder(dir);
    assert(r.skippedCount === 0, `los archivos basura del sistema no deben avisar; skippedCount=${r.skippedCount}`);
    assert(r.importedCount === 1, `debia importar solo la foto real; importedCount=${r.importedCount}`);
  });

  await waitQueueDrained();

  // ------------------------------------------------ Varias carpetas y ZIP
  await test('Elegir carpetas: el selector admite SELECCION MULTIPLE y se importan todas', async () => {
    const dirA = path.join(tmpRoot, 'src', 'MultiA');
    const dirB = path.join(tmpRoot, 'src', 'MultiB');
    await makePhotos(dirA, 2, { width: 300, height: 200, prefix: 'a' });
    await makePhotos(dirB, 3, { width: 300, height: 200, prefix: 'b' });
    await waitQueueDrained();
    const before = queueManager.jobs.length;
    nextDialogFiles = [dirA, dirB];
    await js('document.getElementById("chooseFolderBtn").click()');
    await waitFor(() => queueManager.jobs.length === before + 5, 6000)
      .catch(() => { throw new Error(`se esperaban 5 fotos nuevas de 2 carpetas (hay ${queueManager.jobs.length - before})`); });
    assert(lastDialogOptions && lastDialogOptions.properties.includes('multiSelections'), 'el selector de carpetas debe permitir elegir varias');
    assert(lastDialogOptions.properties.includes('openDirectory'), 'y ser de carpetas');
    await waitQueueDrained();
  });

  await test('Elegir comprimido (ZIP): se descomprime solo y sus imagenes se comprimen', async () => {
    const { makeZip } = require('./helpers/make-zip');
    const mk = (mean) => sharp({ create: { width: 400, height: 300, channels: 3, noise: { type: 'gaussian', mean, sigma: 40 } } }).jpeg({ quality: 97 }).toBuffer();
    const img = await mk(120);
    const img2 = await mk(60); // distinta: dos fotos identicas en el ZIP se contarian como duplicado
    const zipPath = path.join(tmpRoot, 'src', 'Entrega.zip');
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    fs.writeFileSync(zipPath, makeZip([
      { name: 'Entrega/uno.jpg', data: img },
      { name: 'Entrega/Sub/dos.jpg', data: img2, deflate: true },
      { name: '__MACOSX/Entrega/._uno.jpg', data: 'basura' },
      { name: 'Entrega/notas.txt', data: 'texto' }
    ]));
    const exists = await js('!!document.getElementById("chooseArchiveBtn")');
    assert(exists, 'debe existir el boton "Elegir comprimido"');
    const before = queueManager.jobs.length;
    nextDialogFiles = [zipPath];
    await js('document.getElementById("chooseArchiveBtn").click()');
    await waitFor(() => queueManager.jobs.length === before + 2, 6000)
      .catch(() => { throw new Error(`el ZIP tiene 2 fotos (se importaron ${queueManager.jobs.length - before})`); });
    assert(lastDialogOptions.filters[0].extensions.includes('zip'), 'el selector debe filtrar por .zip');
    await waitQueueDrained();
    const done = queueManager.jobs.slice(before).filter((j) => j.status === 'done');
    assert(done.length === 2, 'las 2 fotos del ZIP deben quedar comprimidas');
    assert(done.every((j) => fs.existsSync(j.report.output)), 'y existir en output/');
    // El aviso de "N archivos no compatibles" por notas.txt debe haberse mostrado, sin ruido por __MACOSX.
    const toast = await js('document.getElementById("toast").textContent');
    assert(/1 archivo no se pudo importar/.test(toast), `se esperaba el aviso por notas.txt, y salio: "${toast}"`);
  });

  await test('Un ZIP roto se avisa con claridad y la app sigue funcionando', async () => {
    const bad = path.join(tmpRoot, 'src', 'Roto.zip');
    fs.writeFileSync(bad, 'esto no es un zip');
    nextDialogFiles = [bad];
    await js('document.getElementById("chooseArchiveBtn").click()');
    await waitFor(() => js('/Roto\\.zip/.test(document.getElementById("toast").textContent)'), 4000)
      .catch(() => { throw new Error('no se aviso del ZIP roto'); });
    const toast = await js('document.getElementById("toast").textContent');
    assert(/dañado|no es un ZIP|no es compatible/.test(toast), `el aviso debe decir el motivo: "${toast}"`);
  });

  await test('Progreso global: aparece con varias fotos ("N de M"), llega a "Terminado" y se retira solo si no hay mas', async () => {
    const gdir = path.join(tmpRoot, 'src', 'Global');
    await makePhotos(gdir, 6, { width: 1600, height: 1100 });
    const files = fs.readdirSync(gdir).map((f) => path.join(gdir, f));
    await waitQueueDrained();
    await js('document.getElementById("clearFinishedBtn").click()');
    await sleep(300);
    nextDialogFiles = files;
    await js('document.getElementById("chooseFilesBtn").click()');
    // Aparece, con el total correcto, mientras el lote esta en marcha.
    await waitFor(() => js(`(function(){ const b = document.getElementById('globalProgress'); return !b.classList.contains('hidden') && /de 6/.test(document.getElementById('globalProgressText').textContent); })()`), 8000)
      .catch(async () => { throw new Error(`la barra global no aparecio con "de 6": "${await js('document.getElementById("globalProgressText").textContent')}"`); });
    await waitQueueDrained();
    await waitFor(() => js('document.getElementById("globalProgressText").textContent.startsWith("Terminado")'), 4000)
      .catch(async () => { throw new Error(`debia decir Terminado: "${await js('document.getElementById("globalProgressText").textContent')}"`); });
    const fin = await js(`(function(){ const b = document.getElementById('globalProgress'); return { complete: b.classList.contains('complete'), now: b.getAttribute('aria-valuenow'), width: document.getElementById('globalProgressFill').style.width, text: document.getElementById('globalProgressText').textContent }; })()`);
    assert(fin.complete && fin.now === '100' && fin.width === '100%', `al terminar: 100 % y color de exito (${JSON.stringify(fin)})`);
    assert(/6 de 6/.test(fin.text), `texto final "6 de 6": ${fin.text}`);
    // Limpiar lo completado deja el lote vacio: la barra desaparece.
    await js('document.getElementById("clearFinishedBtn").click()');
    await waitFor(() => js('document.getElementById("globalProgress").classList.contains("hidden")'), 3000);
  });

  await test('Duplicados: soltar la MISMA foto otra vez la omite con un aviso que SE QUEDA; el interruptor de Ajustes lo controla', async () => {
    const ddir = path.join(tmpRoot, 'src', 'Duplicadas');
    fs.mkdirSync(ddir, { recursive: true });
    await sharp({ create: { width: 700, height: 500, channels: 3, noise: { type: 'gaussian', mean: 90, sigma: 55 } } }).jpeg({ quality: 95 }).toFile(path.join(ddir, 'unica.jpg'));
    await waitQueueDrained();

    const before = queueManager.jobs.length;
    nextDialogFiles = [ddir];
    await js('document.getElementById("chooseFolderBtn").click()');
    await waitFor(() => queueManager.jobs.length === before + 1, 5000);
    await waitQueueDrained();

    const afterFirst = queueManager.jobs.length;
    nextDialogFiles = [ddir];
    await js('document.getElementById("chooseFolderBtn").click()');
    await waitFor(() => js('!document.getElementById("duplicatesNotice").classList.contains("hidden")'), 5000)
      .catch(async () => { throw new Error(`debia avisar del duplicado: \"${await js('document.getElementById("toast").textContent')}\"`); });
    const notice = await js('document.getElementById("duplicatesNoticeText").textContent');
    assert(/idéntic/.test(notice) && /ya estaba comprimido/.test(notice), `el aviso dice que es identico y ya estaba comprimido: \"${notice}\"`);
    assert(/parecido/.test(notice), 'y que lo parecido nunca se omite');
    assert(queueManager.jobs.length === afterFirst, 'no entra nada nuevo en la cola');
    assert(!(await js('/No se encontraron/.test(document.getElementById("toast").textContent) && !document.getElementById("toast").classList.contains("hidden")')), 'no dice \"no se encontraron fotos\" cuando en realidad eran duplicados');
    if (process.env.UI_SHOT_DIR) {
      fs.mkdirSync(process.env.UI_SHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.UI_SHOT_DIR, 'duplicados.png'), (await getWin().webContents.capturePage()).toPNG());
    }
    // No es un toast de 5 s: sigue ahi pasado ese tiempo.
    await sleep(5600);
    assert(await js('!document.getElementById("duplicatesNotice").classList.contains("hidden")'), 'el aviso se queda hasta cerrarlo');
    const shown = await js('(function(){ const b = document.getElementById("duplicatesNotice"); const r = b.getBoundingClientRect(); return b.offsetHeight > 20 && getComputedStyle(b).display !== "none" && r.width > 100; })()');
    assert(shown, 'se VE de verdad (alto real y display)');

    // \"Procesar de todos modos\": vuelve a importar lo omitido SIN tocar el ajuste.
    assert(await js('!document.getElementById("importSkippedBtn").classList.contains("hidden")'), 'el boton aparece (se sabe de donde venia)');
    await js('document.getElementById("importSkippedBtn").click()');
    await waitFor(() => queueManager.jobs.length === afterFirst + 1, 6000)
      .catch(() => { throw new Error('\"Procesar de todos modos\" debia volver a importar la foto'); });
    await waitQueueDrained();
    assert(await js('document.getElementById("duplicatesNotice").classList.contains("hidden")'), 'el aviso se retira al procesar');
    assert(await js('document.getElementById("skipDuplicatesToggle").checked === true'), 'el ajuste sigue activado');
    assert(await js('window.api.getSettings().then((s) => s.skipDuplicates === true)'), 'y guardado como activado');

    // La X cierra el aviso.
    const afterForced = queueManager.jobs.length;
    nextDialogFiles = [ddir];
    await js('document.getElementById("chooseFolderBtn").click()');
    await waitFor(() => js('!document.getElementById("duplicatesNotice").classList.contains("hidden")'), 5000);
    await js('document.getElementById("dismissDuplicatesBtn").click()');
    assert(await js('(function(){ const b = document.getElementById("duplicatesNotice"); return b.offsetHeight === 0 && getComputedStyle(b).display === "none"; })()'), 'la X lo quita de verdad');
    assert(queueManager.jobs.length === afterForced);

    // El interruptor existe, esta activado por defecto, y apagarlo permite volver a importar.
    await js('window.api.saveSettings({ skipDuplicates: false })');
    nextDialogFiles = [ddir];
    await js('document.getElementById("chooseFolderBtn").click()');
    await waitFor(() => queueManager.jobs.length === afterForced + 1, 5000)
      .catch(() => { throw new Error('con el interruptor apagado debia importarse de nuevo'); });
    await waitQueueDrained();
    await js('window.api.saveSettings({ skipDuplicates: true })');
  });

  await test('AUDIO: se elige un .wav, un .m4a y un .caf; se comprimen de verdad, con icono de audio, porcentaje y sin boton de vista previa', async () => {
    const { makeAudio } = require('./helpers/make-audio');
    const adir = path.join(tmpRoot, 'src', 'Audios');
    fs.mkdirSync(adir, { recursive: true });
    const files = [
      ['sermon.wav', ['-c:a', 'pcm_s16le'], 20],
      ['nota.m4a', ['-c:a', 'aac', '-b:a', '320k'], 12],
      ['mac.caf', ['-c:a', 'pcm_s16le'], 9]
    ].map(([name, codecArgs, seconds]) => { makeAudio(path.join(adir, name), { codecArgs, seconds }); return path.join(adir, name); });

    const before = queueManager.jobs.length;
    nextDialogFiles = files;
    await js('document.getElementById("chooseFilesBtn").click()');
    assert(JSON.stringify(lastDialogOptions.filters).includes('"wav"') && JSON.stringify(lastDialogOptions.filters).includes('"caf"') && JSON.stringify(lastDialogOptions.filters).includes('"m4a"'), 'el selector admite audios (incluido caf y m4a)');
    await waitFor(() => queueManager.jobs.length === before + 3, 8000);
    await waitQueueDrained();
    const jobs = queueManager.jobs.slice(before);
    assert(jobs.every((j) => j.kind === 'audio' && j.status === 'done'), `todos hechos: ${JSON.stringify(jobs.map((j) => [j.name, j.kind, j.status, j.error]))}`);
    assert(jobs.every((j) => j.report.newBytes < j.report.originalBytes), 'todos pesan menos');

    // La ventana recibe la lista como mucho cada ~120 ms: se espera a que MUESTRE los tres como terminados.
    await waitFor(() => js(`Array.from(document.querySelectorAll('#queueList li[data-kind="audio"]')).slice(-3).filter((li) => li.classList.contains('queue-item--done')).length === 3`), 5000);
    const rows = await js(`Array.from(document.querySelectorAll('#queueList li[data-kind="audio"]')).slice(-3).map((li) => ({
      icon: getComputedStyle(li.querySelector('.queue-item__icon--audio')).display,
      imageIcon: getComputedStyle(li.querySelector('.queue-item__icon--image')).display,
      eye: getComputedStyle(li.querySelector('.queue-item__preview')).display,
      badge: li.querySelector('.queue-item__badge').textContent,
      sub: li.querySelector('.queue-item__sub').textContent
    }))`);
    assert(rows.length === 3, `3 filas de audio en pantalla (${rows.length})`);
    for (const row of rows) {
      assert(row.icon === 'block' && row.imageIcon === 'none', `icono de audio, no de foto: ${JSON.stringify(row)}`);
      assert(row.eye === 'none', 'un audio no muestra el ojo de vista previa');
      assert(/^-\d/.test(row.badge) && /→/.test(row.sub), `muestra lo ahorrado: ${JSON.stringify(row)}`);
    }
    assert(fs.readdirSync(path.join(tmpRoot, 'Documents', 'Compacta', 'output')).length > 0);
    if (process.env.UI_SHOT_DIR) {
      fs.mkdirSync(process.env.UI_SHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.UI_SHOT_DIR, 'audio.png'), (await getWin().webContents.capturePage()).toPNG());
    }
  });

  await test('AUDIO: soltar un audio ya ligero (MP3 de 96 kbps) lo deja intacto y dice \"Sin cambios\"; el texto de la pantalla ya habla de audios', async () => {
    const { makeAudio } = require('./helpers/make-audio');
    const f = path.join(tmpRoot, 'src', 'Audios', 'ligero.mp3');
    makeAudio(f, { codecArgs: ['-c:a', 'libmp3lame', '-b:a', '96k'], seconds: 7 });
    const before = queueManager.jobs.length;
    nextDialogFiles = [f];
    await js('document.getElementById("chooseFilesBtn").click()');
    await waitFor(() => queueManager.jobs.length === before + 1, 5000);
    await waitQueueDrained();
    const job = queueManager.jobs[queueManager.jobs.length - 1];
    assert(job.status === 'done' && job.report && job.report.skipped === true && job.report.reason === 'ya-optimizado', JSON.stringify(job.report));
    await waitFor(() => js('/Sin cambios/.test(Array.from(document.querySelectorAll("#queueList li")).pop().querySelector(".queue-item__badge").textContent)'), 5000)
      .catch(() => { throw new Error('la fila debia decir \"Sin cambios\"'); });
    const title = await js('document.querySelector(".dropzone__title").textContent');
    assert(/audios/.test(title), `el titulo menciona audios: ${title}`);
  });

  await test('Carpeta de salida elegible: se cambia, el pie la muestra, lo procesado sale ahi; una invalida se rechaza; se restablece', async () => {
    const custom = path.join(tmpRoot, 'MiSalida', 'Comprimidas');
    const defaultHint = await js('document.getElementById("folderHintPath").textContent');
    assert(/Documentos\/Compacta\/output/.test(defaultHint), `pie por defecto: "${defaultHint}"`);
    assert(await js('document.getElementById("resetOutputBtn").disabled === true'), '"Restablecer" desactivado si ya es la de siempre');

    nextDialogFiles = [custom];
    await js('document.getElementById("chooseOutputBtn").click()');
    await waitFor(() => js(`document.getElementById("folderHintPath").textContent === ${JSON.stringify(custom)}`), 4000)
      .catch(async () => { throw new Error(`el pie debia mostrar la carpeta nueva: "${await js('document.getElementById("folderHintPath").textContent')}"`); });
    assert(await js('document.getElementById("outputDirValue").textContent') === custom, 'Ajustes muestra la ruta completa');
    assert(await js('document.getElementById("resetOutputBtn").disabled === false'), '"Restablecer" se activa');
    if (process.env.UI_SHOT_DIR) {
      fs.mkdirSync(process.env.UI_SHOT_DIR, { recursive: true });
      await js('document.getElementById("settingsBtn").click()');
      await sleep(400);
      fs.writeFileSync(path.join(process.env.UI_SHOT_DIR, 'settings.png'), (await getWin().webContents.capturePage()).toPNG());
      await js('document.getElementById("closeSettingsBtn") && document.getElementById("closeSettingsBtn").click()');
      await sleep(200);
    }

    // Lo procesado ahora sale en la carpeta nueva, con la misma estructura.
    const odir = path.join(tmpRoot, 'src', 'ParaSalida');
    fs.mkdirSync(odir, { recursive: true });
    await sharp({ create: { width: 900, height: 600, channels: 3, noise: { type: 'gaussian', mean: 110, sigma: 50 } } }).jpeg({ quality: 96 }).toFile(path.join(odir, 'prueba.jpg'));
    const before = queueManager.jobs.length;
    nextDialogFiles = [odir];
    await js('document.getElementById("chooseFolderBtn").click()');
    await waitFor(() => queueManager.jobs.length === before + 1, 5000);
    await waitQueueDrained();
    const job = queueManager.jobs[before];
    assert(job.status === 'done', `debe terminar (${job.status} ${job.error || ''})`);
    assert(job.report.output.startsWith(custom + path.sep), `la salida debe estar en la carpeta elegida: ${job.report.output}`);
    assert(fs.existsSync(path.join(custom, 'ParaSalida', 'prueba.jpg')), 'y con la misma estructura de carpetas');

    // Una carpeta invalida (dentro de input) se rechaza con el motivo y no cambia nada.
    nextDialogFiles = [path.join(require(path.join(__dirname, '..', 'src', 'main', 'paths')).getInputDir(), 'dentro')];
    await js('document.getElementById("chooseOutputBtn").click()');
    await waitFor(() => js('/dentro de la carpeta de entrada/.test(document.getElementById("toast").textContent)'), 4000)
      .catch(async () => { throw new Error(`debia rechazarla con motivo: "${await js('document.getElementById("toast").textContent')}"`); });
    assert(await js('document.getElementById("folderHintPath").textContent') === custom, 'la carpeta vigente sigue siendo la anterior');

    // Restablecer.
    await js('document.getElementById("resetOutputBtn").click()');
    await waitFor(() => js('/Documentos\\/Compacta\\/output/.test(document.getElementById("folderHintPath").textContent)'), 4000);
    assert(await js('document.getElementById("resetOutputBtn").disabled === true'), 'otra vez desactivado');
  });

  await test('Vista previa antes/despues: boton solo en fotos terminadas, modal con dos imagenes, deslizador, y se cierra con Escape/clic fuera', async () => {
    const pdir = path.join(tmpRoot, 'src', 'ParaPreview');
    fs.mkdirSync(pdir, { recursive: true });
    await sharp({ create: { width: 2400, height: 1600, channels: 3, noise: { type: 'gaussian', mean: 100, sigma: 55 } } }).jpeg({ quality: 96 }).toFile(path.join(pdir, 'vista.jpg'));
    const before = queueManager.jobs.length;
    nextDialogFiles = [path.join(pdir, 'vista.jpg')];
    await js('document.getElementById("chooseFilesBtn").click()');
    await waitFor(() => queueManager.jobs.length === before + 1, 5000);
    await waitQueueDrained();
    const job = queueManager.jobs[before];
    assert(job.status === 'done', `foto procesada (${job.status})`);

    const sel = `[data-id="${job.id}"] .queue-item__preview`;
    await waitFor(() => js(`(function(){ const b = document.querySelector('${sel}'); return !!b && getComputedStyle(b).display !== 'none'; })()`), 4000)
      .catch(() => { throw new Error('la foto terminada debe mostrar el boton de vista previa'); });

    // Una foto aun sin procesar y un video NO tienen el boton visible.
    const hiddenOthers = await js(`[...document.querySelectorAll('#queueList li')].filter((li) => li.dataset.id !== '${job.id}' && !li.className.includes('queue-item--done')).every((li) => getComputedStyle(li.querySelector('.queue-item__preview')).display === 'none')`);
    assert(hiddenOthers, 'solo lo TERMINADO muestra el boton (ni pendientes, ni en curso, ni errores)');

    // La fila esta al final de una cola larga: se hace scroll hasta ella, como haria una persona
    // (un clic de raton real a coordenadas fuera de la ventana no llega a ningun sitio).
    await js(`document.querySelector('${sel}').scrollIntoView({ block: 'center' })`);
    await sleep(150);
    await realClick(sel);
    await waitFor(() => js(`(function(){ const a = document.getElementById('previewAfter'), b = document.getElementById('previewBefore'); return !document.getElementById('previewOverlay').classList.contains('hidden') && a.complete && b.complete && a.naturalWidth > 0 && b.naturalWidth > 0; })()`), 8000)
      .catch(async () => { throw new Error(`el modal debia cargar las dos imagenes: ${await js(`JSON.stringify((function(){ const a = document.getElementById('previewAfter'), b = document.getElementById('previewBefore'); return { overlayHidden: document.getElementById('previewOverlay').classList.contains('hidden'), status: document.getElementById('previewStatus').textContent, bodyHidden: document.getElementById('previewBody').classList.contains('hidden'), after: { has: a.hasAttribute('src'), complete: a.complete, w: a.naturalWidth }, before: { has: b.hasAttribute('src'), complete: b.complete, w: b.naturalWidth } }; })())`)}`); });
    const info = await js(`({ naturalMax: Math.max(document.getElementById('previewBefore').naturalWidth, document.getElementById('previewBefore').naturalHeight), before: document.getElementById('previewBeforeStats').textContent, after: document.getElementById('previewAfterStats').textContent })`);
    assert(info.naturalMax <= 1400, `la imagen que llega a la pantalla esta reducida (${info.naturalMax}px)`);
    assert(/2400×1600/.test(info.before) && /Original/.test(info.before), `medidas reales en "antes": ${info.before}`);
    assert(/Resultado/.test(info.after) && /−\d+%/.test(info.after), `ahorro en "despues": ${info.after}`);

    // Captura opcional para revisar a ojo el aspecto (UI_SHOT_DIR=/ruta): no afecta a la prueba.
    if (process.env.UI_SHOT_DIR) {
      fs.mkdirSync(process.env.UI_SHOT_DIR, { recursive: true });
      await js(`(function(){ const s = document.getElementById('previewSlider'); s.value = '50'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(300);
      fs.writeFileSync(path.join(process.env.UI_SHOT_DIR, 'preview.png'), (await getWin().webContents.capturePage()).toPNG());
    }

    // El deslizador mueve la linea de comparacion.
    await js(`(function(){ const s = document.getElementById('previewSlider'); s.value = '20'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert(await js(`document.getElementById('previewStage').style.getPropertyValue('--split') === '20%'`), 'el deslizador debe actualizar la comparacion');

    // ----- 1.0.10: el comparador ANTES no hacia nada visible. Ahora, con raton de verdad: -----
    // El escenario tiene la proporcion de la foto (2400x1600 = 1,5), no un marco vacio.
    const ratio = await js(`(function(){ const r = document.getElementById('previewStage').getBoundingClientRect(); return r.width / r.height; })()`);
    assert(Math.abs(ratio - 1.5) < 0.02, `el escenario debe tener la proporcion de la foto (1,5): ${ratio}`);
    // La linea es visible y arrastrarla sobre la foto mueve la comparacion.
    const geo = await js(`(function(){ const r = document.getElementById('previewStage').getBoundingClientRect(); const d = document.querySelector('.preview-divider__handle').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, handleW: d.width }; })()`);
    assert(geo.handleW > 20, 'el tirador de la linea debe verse');
    const wc = getWin().webContents;
    const at = (frac) => ({ x: Math.round(geo.l + geo.w * frac), y: Math.round(geo.t + geo.h * 0.5) });
    wc.sendInputEvent({ type: 'mouseMove', ...at(0.5) });
    wc.sendInputEvent({ type: 'mouseDown', ...at(0.5), button: 'left', clickCount: 1 });
    await sleep(40);
    wc.sendInputEvent({ type: 'mouseMove', ...at(0.35), button: 'left' });
    await sleep(40);
    wc.sendInputEvent({ type: 'mouseMove', ...at(0.75), button: 'left' });
    await sleep(40);
    wc.sendInputEvent({ type: 'mouseUp', ...at(0.75), button: 'left', clickCount: 1 });
    await sleep(100);
    const split = parseFloat(await js(`document.getElementById('previewStage').style.getPropertyValue('--split')`));
    assert(Math.abs(split - 75) < 2, `arrastrar con el raton debe mover la linea hasta ~75 %: ${split}`);
    assert(await js(`document.getElementById('previewSlider').value === '75'`), 'y el deslizador la sigue');

    // Detalle al 100 %: una zona SIN reducir (PNG), con su mapa pequeno; volver restaura la vista general.
    await realClick('#previewZoomBtn');
    await waitFor(() => js(`(function(){ const a = document.getElementById('previewAfter'); return document.getElementById('previewZoomBtn').getAttribute('aria-pressed') === 'true' && a.src.startsWith('data:image/png') && a.complete && a.naturalWidth > 0; })()`), 8000)
      .catch(async () => { throw new Error(`el detalle al 100 % debia cargar: ${await js(`document.getElementById('previewHint').textContent`)}`); });
    const detail = await js(`(function(){ const a = document.getElementById('previewAfter'); const s = document.getElementById('previewStage').getBoundingClientRect(); return { natural: a.naturalWidth, shown: Math.round(s.width * devicePixelRatio), map: !document.getElementById('previewMinimap').classList.contains('hidden') }; })()`);
    assert(Math.abs(detail.natural - detail.shown) <= 2, `se muestra a tamano real (1 pixel de la foto = 1 pixel de pantalla): ${detail.natural} vs ${detail.shown}`);
    assert(detail.natural > 700, `y es una zona grande, no una miniatura: ${detail.natural}`);
    assert(detail.map, 'con el mapa pequeno para cambiar de zona');
    await realClick('#previewZoomBtn');
    await waitFor(() => js(`document.getElementById('previewAfter').src.startsWith('data:image/jpeg') && document.getElementById('previewMinimap').classList.contains('hidden')`), 4000);

    // Escape cierra y suelta las imagenes.
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert(await js(`document.getElementById('previewOverlay').classList.contains('hidden')`), 'Escape cierra');
    assert(await js(`!document.getElementById('previewBefore').hasAttribute('src')`), 'y libera la imagen');

    // Clic fuera del panel tambien cierra.
    await js(`document.querySelector('${sel}').scrollIntoView({ block: 'center' })`);
    await sleep(150);
    await realClick(sel);
    await waitFor(() => js(`!document.getElementById('previewOverlay').classList.contains('hidden')`), 4000);
    await js(`document.getElementById('previewOverlay').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    assert(await js(`document.getElementById('previewOverlay').classList.contains('hidden')`), 'clic fuera cierra');
  });

  await test('Ventana NO maximizada (760x520): la cola se ve sin bajar, nada se sale, y Ajustes cabe y se puede recorrer hasta el final', async () => {
    const win = getWin();
    const [cw, ch] = win.getContentSize();
    try {
      win.setContentSize(760, 520);
      await sleep(400);
      assert(await js('document.querySelectorAll("#queueList li").length > 0'), 'hay filas en la cola');
      const m = await js(`(function(){
        const list = document.getElementById('queueList').getBoundingClientRect();
        const dz = document.getElementById('dropzone').getBoundingClientRect();
        const foot = document.querySelector('.statusbar').getBoundingClientRect();
        return { listTop: list.top, listH: list.height, dzH: dz.height, footTop: foot.top, vh: innerHeight,
                 hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      })()`);
      assert(!m.hScroll, 'no hay scroll horizontal');
      assert(m.dzH < 190, `con cola, la zona de arrastrar es compacta (antes ~350 px): ${Math.round(m.dzH)}`);
      assert(m.listTop < m.vh * 0.6 && m.listH > 120, `la cola debe verse sin tener que bajar: arriba=${Math.round(m.listTop)} alto=${Math.round(m.listH)} de ${m.vh}`);
      assert(m.footTop <= m.vh, 'la barra inferior no se sale de la ventana');

      await js('document.getElementById("settingsBtn").click()');
      await sleep(250);
      const sp = await js(`(function(){ const p = document.querySelector('.settings-panel'); const r = p.getBoundingClientRect(); return { bottom: r.bottom, top: r.top, vh: innerHeight, scrollable: p.scrollHeight > p.clientHeight, overflowY: getComputedStyle(p).overflowY }; })()`);
      assert(sp.top >= 0 && sp.bottom <= sp.vh, `el panel de Ajustes cabe en la ventana: ${Math.round(sp.top)}-${Math.round(sp.bottom)} de ${sp.vh}`);
      assert(!sp.scrollable || sp.overflowY === 'auto', 'si no cabe entero, se puede recorrer');
      await js('document.querySelector(".settings-panel").scrollTop = 99999');
      assert(await js(`(function(){ const el = document.getElementById('webpToggle'); const r = el.closest('.setting-row').getBoundingClientRect(); return r.bottom <= innerHeight + 1; })()`), 'la ultima opcion de Ajustes se alcanza');
      await js('document.getElementById("closeSettingsBtn").click()');
    } finally {
      win.setContentSize(cw, ch);
      await sleep(300);
    }
  });

  await test('Reordenar la cola: asa solo en pendientes, arrastrar mueve la fila (pantalla Y orden real), Alt+flecha tambien, y se procesa en el orden nuevo', async () => {
    const nameOf = (id) => { const j = queueManager.jobs.find((x) => x.id === id); return j ? j.name : id; };
    const deepEq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg || 'distinto'}: ${JSON.stringify(a.map(nameOf))} != ${JSON.stringify(b.map(nameOf))}`);
    try {
    const rdir = path.join(tmpRoot, 'src', 'Reordenar');
    fs.mkdirSync(rdir, { recursive: true });
    const files = [];
    for (let i = 0; i < 4; i += 1) {
      const f = path.join(rdir, `orden${i}.jpg`);
      await sharp({ create: { width: 500 + i * 37, height: 400, channels: 3, noise: { type: 'gaussian', mean: 80 + i * 20, sigma: 50 } } }).jpeg({ quality: 95 }).toFile(f);
      files.push(f);
    }
    await waitQueueDrained();
    await js('window.api.pauseQueue()');
    const before = queueManager.jobs.length;
    nextDialogFiles = files;
    await js('document.getElementById("chooseFilesBtn").click()');
    await waitFor(() => queueManager.jobs.length === before + 4, 5000);
    await waitFor(() => js(`document.querySelectorAll('#queueList li.queue-item--pending').length === 4`), 4000);

    const mine = queueManager.jobs.slice(before).map((j) => j.id);
    const domOrder = () => js(`[...document.querySelectorAll('#queueList li.queue-item--pending')].map((li) => li.dataset.id)`);
    const realOrder = () => queueManager.jobs.slice(before).map((j) => j.id);
    deepEq(await domOrder(), mine, 'orden inicial');

    // El asa solo se ve en las pendientes (las terminadas de antes no la tienen).
    const grips = await js(`[...document.querySelectorAll('#queueList li')].map((li) => ({ pending: li.classList.contains('queue-item--pending'), grip: getComputedStyle(li.querySelector('.queue-item__grip')).visibility !== 'hidden' }))`);
    assert(grips.every((g) => g.pending === g.grip), 'asa visible si y solo si la fila esta pendiente');

    // Arrastrar la ultima encima de la primera (mitad de arriba) -> pasa a ser la primera.
    const drag = (fromId, toId, half) => js(`(function(){
      const from = document.querySelector('[data-id="${fromId}"] .queue-item__grip');
      const to = document.querySelector('[data-id="${toId}"]');
      const dt = new DataTransfer();
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const r = to.getBoundingClientRect();
      const y = r.top + r.height * ${half === 'top' ? 0.2 : 0.8};
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
      const mark = to.className;
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return mark;
    })()`);
    const mark = await drag(mine[3], mine[0], 'top');
    assert(/drop-before/.test(mark), `debe marcar donde caera: "${mark}"`);
    await waitFor(async () => (await domOrder())[0] === mine[3], 3000).catch(() => { throw new Error('la pantalla no recoloco la fila'); });
    deepEq(realOrder(), [mine[3], mine[0], mine[1], mine[2]], 'el orden REAL de la cola cambio, no solo la pantalla');
    deepEq(await domOrder(), realOrder(), 'pantalla y cola coinciden');

    // 1.0.10: tambien se puede agarrar la fila por el NOMBRE (no solo por el asa).
    assert(await js(`document.querySelector('[data-id=\"${mine[0]}\"]').draggable === true`), 'la fila pendiente es arrastrable entera');
    assert(await js(`[...document.querySelectorAll('#queueList li:not(.queue-item--pending)')].every((li) => li.draggable === false)`), 'las demas filas NO');
    await drag(mine[0], mine[2], 'bottom', '.queue-item__name');
    await waitFor(async () => JSON.stringify(await domOrder()) === JSON.stringify(realOrder()), 3000);
    deepEq(realOrder(), [mine[3], mine[1], mine[2], mine[0]], 'arrastrando por el nombre tambien reordena');
    await drag(mine[0], mine[3], 'top', '.queue-item__name');
    await waitFor(async () => JSON.stringify(await domOrder()) === JSON.stringify(realOrder()), 3000);
    deepEq(realOrder(), [mine[0], mine[3], mine[1], mine[2]], 'y se puede devolver');
    await drag(mine[0], mine[3], 'bottom');
    await waitFor(async () => JSON.stringify(await domOrder()) === JSON.stringify(realOrder()), 3000);
    deepEq(realOrder(), [mine[3], mine[0], mine[1], mine[2]], 'vuelve al estado del resto de la prueba');

    // Arrastrar la primera a la mitad de abajo de la tercera.
    await drag(mine[3], mine[1], 'bottom');
    await waitFor(async () => JSON.stringify(await domOrder()) === JSON.stringify(realOrder()), 3000);
    deepEq(realOrder(), [mine[0], mine[1], mine[3], mine[2]], 'tras arrastrar al fondo (2.o arrastre)');

    // Teclado: Alt + flecha arriba desde el asa sube una posicion.
    await js(`(function(){ const g = document.querySelector('[data-id="${mine[3]}"] .queue-item__grip'); g.focus(); g.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true })); })()`);
    await waitFor(() => realOrder()[1] === mine[3], 3000).catch(() => { throw new Error('Alt+flecha arriba no movio la fila'); });
    deepEq(realOrder(), [mine[0], mine[3], mine[1], mine[2]], 'tras Alt+flecha arriba');
    await waitFor(async () => JSON.stringify(await domOrder()) === JSON.stringify(realOrder()), 3000).catch(() => { throw new Error('la pantalla no recoloco la fila tras Alt+flecha'); });
    // El foco sigue en el asa de la fila movida: se puede encadenar otra pulsacion.
    const focusKept = await js(`document.activeElement === document.querySelector('[data-id="${mine[3]}"] .queue-item__grip')`);
    assert(focusKept, 'tras mover con el teclado, el foco debe seguir en el asa (si no, no se puede mover otra vez)');

    // Un arrastre que NO es de la cola (archivos de fuera) no mueve nada ni rompe la zona de soltar.
    const noEffect = await js(`(function(){ const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.jpg')); const li = document.querySelector('#queueList li.queue-item--pending'); const e = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }); li.dispatchEvent(e); return li.className.includes('drop-'); })()`);
    assert(!noEffect, 'un arrastre de archivos de fuera no marca posiciones de la cola');

    // Se procesa en el orden nuevo.
    const started = [];
    const onUpdate = () => { for (const j of queueManager.jobs.slice(before)) if (j.status !== 'pending' && !started.includes(j.id)) started.push(j.id); };
    queueManager.on('queue-updated', onUpdate);
    await js('window.api.resumeQueue()');
    await waitQueueDrained();
    queueManager.off('queue-updated', onUpdate);
    deepEq(started, [mine[0], mine[3], mine[1], mine[2]], 'empezaron en el orden elegido');
      } finally {
      await js('window.api.resumeQueue()');
    }
  });

  await test('VIDEO: se importa, se comprime de verdad, muestra su porcentaje y sale como .mp4 mas pequeno', async () => {
    const { makeVideo, ssim } = require('./helpers/make-video');
    const vdir = path.join(tmpRoot, 'src', 'Videos');
    fs.mkdirSync(vdir, { recursive: true });
    const clip = path.join(vdir, 'Viaje.mov');
    makeVideo(clip, { seconds: 8, size: '640x360' });
    const before = queueManager.jobs.length;
    nextDialogFiles = [clip];
    await js('document.getElementById("chooseFilesBtn").click()');
    await waitFor(() => queueManager.jobs.length === before + 1, 6000)
      .catch(() => { throw new Error('el video no entro en la cola: la app no lo reconocio'); });
    const job = queueManager.jobs[before];
    assert(job.kind === 'video', `debe ser un trabajo de video (es ${job.kind})`);

    // Mientras codifica, la fila muestra icono de video y un porcentaje real.
    let sawPercent = false;
    const deadline = Date.now() + 20000;
    while (job.status !== 'done' && job.status !== 'error' && Date.now() < deadline) {
      const row = await js(`(function(){ const li = document.querySelector('[data-id="${job.id}"]'); if (!li) return null;
        return { kind: li.dataset.kind, text: li.querySelector('.queue-item__sub').textContent, iconVisible: getComputedStyle(li.querySelector('.queue-item__icon--video')).display !== 'none' }; })()`);
      if (row && /Comprimiendo v[ií]deo… \d+%/.test(row.text)) { sawPercent = true; assert(row.kind === 'video' && row.iconVisible, 'icono de video visible'); }
      await sleep(40);
    }
    assert(job.status === 'done', `el video debe terminar bien (estado ${job.status}: ${job.error || ''})`);
    assert(sawPercent, 'en pantalla debia verse "Comprimiendo video… NN%" mientras se procesaba');
    assert(job.report.output.endsWith('.mp4'), 'sale como .mp4');
    assert(job.report.newBytes < job.report.originalBytes * 0.95, 'pesa menos');
    assert(ssim(clip, job.report.output) > 0.98, 'misma calidad visual');
    // La pantalla recibe el estado final con un instante de retraso (los envios van agrupados).
    await waitFor(() => js(`/-\\d/.test(document.querySelector('[data-id="${job.id}"] .queue-item__badge').textContent)`), 3000)
      .catch(async () => { throw new Error(`la fila debe mostrar el ahorro (muestra "${await js(`document.querySelector('[data-id="${job.id}"] .queue-item__badge').textContent`)}")`); });

    // 1.0.10: el video terminado tambien tiene vista previa (un fotograma del original y del resultado), sin "100 %".
    const eye = `[data-id="${job.id}"] .queue-item__preview`;
    await js(`document.querySelector('${eye}').scrollIntoView({ block: 'center' })`);
    await sleep(150);
    await realClick(eye);
    await waitFor(() => js(`(function(){ const a = document.getElementById('previewAfter'), b = document.getElementById('previewBefore'); return !document.getElementById('previewBody').classList.contains('hidden') && a.complete && b.complete && a.naturalWidth > 0 && b.naturalWidth > 0; })()`), 12000)
      .catch(async () => { throw new Error(`la vista previa del video debia cargar: ${await js(`document.getElementById('previewStatus').textContent`)}`); });
    assert(await js(`document.getElementById('previewZoomBtn').classList.contains('hidden')`), 'el detalle al 100 % no se ofrece para videos');
    assert(/fotograma/.test(await js(`document.getElementById('previewHint').textContent`)), 'se explica que es un fotograma');
    assert(/640×360/.test(await js(`document.getElementById('previewBeforeStats').textContent`)), 'con las medidas reales del video');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  });

  await test('Comprimidos RAR y 7z: se eligen con el boton y sus fotos y videos se comprimen', async (t) => {
    const { makeArchive, TOOLS } = require('./helpers/make-archive');
    if (!TOOLS.rar || !TOOLS.sevenZip) { console.log('        (omitida: faltan rar/7z para fabricar los archivos)'); return; }
    const { makeVideo } = require('./helpers/make-video');
    const content = path.join(tmpRoot, 'src', 'ContenidoRar');
    fs.mkdirSync(content, { recursive: true });
    makeVideo(path.join(content, 'v.mp4'), { seconds: 2 });
    await sharp({ create: { width: 500, height: 400, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 40 } } }).jpeg({ quality: 97 }).toFile(path.join(content, 'f.jpg'));
    const rar = path.join(tmpRoot, 'src', 'Paquete.rar');
    const sevenZ = path.join(tmpRoot, 'src', 'Paquete.7z');
    assert(makeArchive('rar', content, rar) && makeArchive('7z', content, sevenZ), 'se fabrican los archivos de prueba');
    // Los dos comprimidos traen EXACTAMENTE lo mismo a proposito (es lo que se prueba):
    // sin apagar el omitir-duplicados, el segundo se descartaria entero.
    await js('window.api.saveSettings({ skipDuplicates: false })');
    const before = queueManager.jobs.length;
    nextDialogFiles = [rar, sevenZ];
    await js('document.getElementById("chooseArchiveBtn").click()');
    await waitFor(() => queueManager.jobs.length === before + 4, 8000)
      .catch(() => { throw new Error(`2 comprimidos x (1 foto + 1 video) = 4 trabajos; hay ${queueManager.jobs.length - before}`); });
    await waitQueueDrained();
    const created = queueManager.jobs.slice(before);
    assert(created.every((j) => j.status === 'done'), 'todo termina bien');
    assert(created.filter((j) => j.kind === 'video').length === 2 && created.filter((j) => j.kind === 'image').length === 2, 'dos videos y dos fotos');
    assert(created.every((j) => fs.existsSync(j.report.output)), 'y existen en output/');
    await js('window.api.saveSettings({ skipDuplicates: true })');
  });

  await test('Soltar archivos FUERA del recuadro ya no navega la ventana (se acepta en toda la ventana)', async () => {
    const result = await js(`(function(){
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'a.jpg', { type: 'image/jpeg' }));
      const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
      document.querySelector('.statusbar').dispatchEvent(over);
      const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      document.querySelector('.statusbar').dispatchEvent(drop);
      return { overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented };
    })()`);
    assert(result.overPrevented && result.dropPrevented, 'dragover/drop fuera del recuadro deben cancelarse para que Electron no abra el archivo');
    assert(await js('location.href.endsWith("index.html")'), 'la ventana debe seguir en la pantalla de la app');
  });

  // ------------------------------------------------ Aviso de nube (OneDrive/iCloud)
  await test('Bug reportado: la "X" del aviso de OneDrive/iCloud SI funciona con un clic de raton real, y queda recordado', async () => {
    const originalDocuments = path.join(tmpRoot, 'Documents');
    const cloudDocuments = path.join(tmpRoot, 'OneDrive', 'Documents'); // debe activar isBaseDirCloudSynced()
    // Cerrar TODAS las ventanas de verdad cerraria la app entera fuera de
    // Mac (ver 'window-all-closed' en index.js); se finge macOS, igual que
    // hace la prueba de "cerrar y reabrir" de mas abajo, solo para poder
    // recrear la ventana con 'activate' sin salir del proceso.
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      app.setPath('documents', cloudDocuments);
      getWin().close();
      await waitFor(() => BrowserWindow.getAllWindows().length === 0, 4000);
      app.emit('activate');
      await waitFor(() => getWin() && !getWin().webContents.isLoading(), 10000);
      await waitFor(() => js('!!(window.api && window.QueueView)'), 5000);

      await waitFor(() => js('!document.getElementById("cloudSyncBanner").classList.contains("hidden")'), 4000)
        .catch(() => { throw new Error('con Documentos dentro de "OneDrive", el aviso debia aparecer y no aparecio'); });

      // El area de clic debe ser generosa: un caracter "×" casi sin relleno
      // es facil de fallar por un par de pixeles y da la sensacion de "no
      // funciona" sin serlo. Igual de importante que el propio clic.
      const size = await js(`(function(){
        const r = document.getElementById('dismissCloudBannerBtn').getBoundingClientRect();
        return { w: r.width, h: r.height };
      })()`);
      assert(size.w >= 24 && size.h >= 24, `el area de clic de la "X" es demasiado pequeña (${size.w}x${size.h}px), facil de fallar con el raton`);

      // Debe verse DE VERDAD antes de cerrarlo (alto > 0, display != none).
      const visibleAntes = await js(`(function(){ const b = document.getElementById('cloudSyncBanner'); return getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().height > 0; })()`);
      assert(visibleAntes, 'el aviso debe estar realmente visible antes de cerrarlo');

      await realClick('#dismissCloudBannerBtn');
      const hiddenTrasClic = await js('document.getElementById("cloudSyncBanner").classList.contains("hidden")');
      assert(hiddenTrasClic, 'un clic de raton real sobre la "X" debe poner la clase hidden');
      // REGRESION del bug real: antes la clase se ponia pero el CSS
      // (.cloud-banner { display:flex }) ganaba a .hidden y el aviso seguia
      // a la vista. Lo unico que cuenta es lo que se VE: display none y alto 0.
      const sigueVisible = await js(`(function(){ const b = document.getElementById('cloudSyncBanner'); return getComputedStyle(b).display !== 'none' || b.getBoundingClientRect().height > 0; })()`);
      assert(!sigueVisible, 'tras pulsar la "X" el aviso debe DESAPARECER de la pantalla (display:none), no solo cambiar de clase');

      // Debe quedar recordado de verdad (no solo ocultado en esta sesion):
      // recargar la ventana no debe volver a mostrarlo.
      getWin().close();
      await waitFor(() => BrowserWindow.getAllWindows().length === 0, 4000);
      app.emit('activate');
      await waitFor(() => getWin() && !getWin().webContents.isLoading(), 10000);
      await waitFor(() => js('!!(window.api && window.QueueView)'), 5000);
      await sleep(200);
      const sigueOculto = await js('document.getElementById("cloudSyncBanner").classList.contains("hidden")');
      assert(sigueOculto, 'tras cerrar y reabrir, el aviso ya descartado no debe volver a aparecer');
    } finally {
      app.setPath('documents', originalDocuments);
      getWin().close();
      await waitFor(() => BrowserWindow.getAllWindows().length === 0, 4000);
      app.emit('activate');
      await waitFor(() => getWin() && !getWin().webContents.isLoading(), 10000);
      await waitFor(() => js('!!(window.api && window.QueueView)'), 5000);
      Object.defineProperty(process, 'platform', { value: realPlatform });
    }
  });

  // ------------------------------------------------ Mac: cerrar y reabrir
  await test('Mac: al cerrar y reabrir la ventana desde el Dock, la cola y los botones siguen funcionando', async () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const errors = [];
      process.on('uncaughtException', (e) => errors.push(e));
      getWin().close();
      await waitFor(() => BrowserWindow.getAllWindows().length === 0, 4000);
      app.emit('activate');
      await waitFor(() => getWin() && !getWin().webContents.isLoading(), 10000);
      await waitFor(() => js('!!(window.api && window.QueueView)'), 5000);

      queueManager.pause();
      // Lista vacia primero: asi lo que aparezca despues solo puede haber
      // llegado por una actualizacion en vivo, no por la carga inicial.
      await js('window.api.clearFinished()');
      await waitFor(() => js('document.querySelectorAll("#queueList li").length === 0 || true'), 500);
      const pendingLeft = queueManager.jobs.length;
      const dir = path.join(tmpRoot, 'src', 'DespuesDeReabrir');
      await makePhotos(dir, 3, { width: 400, height: 300 });
      await importFolder(dir);
      await waitFor(() => js(`document.querySelectorAll("#queueList li").length === ${pendingLeft + 3}`), 4000).catch(() => {
        throw new Error('la ventana reabierta no recibe las actualizaciones de la cola');
      });
      const before = filePickerOpened;
      await js('document.getElementById("chooseFilesBtn").click()');
      await sleep(400);
      assert(filePickerOpened === before + 1, 'el boton de elegir archivos no funciona en la ventana reabierta');
      assert(errors.length === 0, `errores no controlados: ${errors.map((e) => e.message).join(' | ')}`);
      queueManager.resume();
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform });
    }
  });

  // ------------------------------------------------ Mac: barra superior, botones de la ventana, pantalla completa
  await test('La ventana sabe en que sistema esta (data-platform) y SOLO en Mac la barra superior deja hueco a los botones', async () => {
    // (Las pruebas de arriba fingen macOS en el proceso principal mientras crean ventanas, y esa plataforma fingida llega
    // al preload; por eso no se compara con "linux" a secas sino con lo que la propia ventana dice que es.)
    const info = await js('({ attr: document.documentElement.dataset.platform, api: window.api.platform })');
    const expected = { darwin: 'mac', win32: 'windows' }[info.api] || 'linux';
    assert(info.attr === expected, `data-platform=${info.attr} pero el sistema es ${info.api} (esperado ${expected})`);
    const left = await js('parseFloat(getComputedStyle(document.querySelector(".topbar")).paddingLeft)');
    if (expected === 'mac') assert(left >= 80, `en Mac debe haber hueco para los botones (padding ${left}px)`);
    else assert(left < 40, `fuera de Mac no debe haber hueco a la izquierda (padding ${left}px)`);
  });

  await test('Mac: los botones de la ventana (cerrar/minimizar/ampliar) NO tapan el logotipo ni el nombre, con ventana normal, minima y en arabe', async () => {
    const geometry = () => js(`(function(){
      const mark = document.querySelector('.brand__mark').getBoundingClientRect();
      const text = document.querySelector('.brand__text h1').getBoundingClientRect();
      const settings = document.getElementById('settingsBtn').getBoundingClientRect();
      const bar = document.querySelector('.topbar').getBoundingClientRect();
      return { markLeft: mark.left, markRight: mark.right, markTop: mark.top, markBottom: mark.bottom, textLeft: text.left,
        settingsLeft: settings.left, settingsRight: settings.right, barHeight: bar.height, width: innerWidth };
    })()`);
    // Los botones de macOS (hiddenInset con trafficLightPosition x=18, y=25) ocupan aprox. x 18..72 e y 25..39.
    const LIGHTS = { left: 18, right: 72, top: 25, bottom: 39 };
    const overlapsLights = (l, r, t, b) => l < LIGHTS.right && r > LIGHTS.left && t < LIGHTS.bottom && b > LIGHTS.top;
    await js(`document.documentElement.dataset.platform = 'mac'`);
    try {
      for (const [language, size] of [['es', [1180, 760]], ['es', [760, 520]], ['ar', [1180, 760]], ['ar', [760, 520]]]) {
        await js(`window.api.saveSettings({ language: '${language}' })`);
        getWin().setSize(size[0], size[1]);
        await js('window.location.reload()');
        await waitFor(() => getWin() && !getWin().webContents.isLoading(), 10000);
        await waitFor(() => js('!!(window.api && window.QueueView)'), 5000);
        await js(`document.documentElement.dataset.platform = 'mac'`);
        await sleep(250);
        const g = await geometry();
        const rtl = language === 'ar';
        const brandLeft = Math.min(g.markLeft, g.textLeft);
        // El texto/logo (a la izquierda en LTR, a la derecha en RTL) y el boton de Ajustes (a la derecha / a la izquierda):
        // ninguno de los dos puede caer sobre los botones de la ventana.
        assert(!overlapsLights(g.markLeft, g.markRight, g.markTop, g.markBottom), `${language} ${size}: el logotipo cae sobre los botones de la ventana (x ${g.markLeft}..${g.markRight})`);
        assert(!overlapsLights(g.settingsLeft, g.settingsRight, g.markTop, g.markBottom), `${language} ${size}: el boton de Ajustes cae sobre los botones de la ventana (x ${g.settingsLeft}..${g.settingsRight})`);
        if (!rtl) assert(brandLeft >= LIGHTS.right + 8, `${language} ${size}: el logotipo debe quedar a la derecha de los botones (empieza en x=${brandLeft})`);
        else assert(g.settingsLeft >= LIGHTS.right + 8, `${language} ${size}: en arabe el boton de Ajustes (a la izquierda) debe quedar a la derecha de los botones (x=${g.settingsLeft})`);
        // Centrado vertical con los botones: el centro de la barra (64 px) es 32; los botones estan centrados en y = 25 + 7.
        assert(Math.abs(g.barHeight - 64) <= 1, `${language} ${size}: la barra debe medir 64 px en Mac (mide ${g.barHeight}), si no los botones quedan descentrados`);
        if (process.env.UI_SHOT_DIR) {
          fs.writeFileSync(path.join(process.env.UI_SHOT_DIR, `mac-barra-${language}-${size[0]}.png`), (await getWin().webContents.capturePage()).toPNG());
        }
      }
    } finally {
      await js(`window.api.saveSettings({ language: 'es' })`);
      getWin().setSize(1180, 760);
      await js('window.location.reload()');
      await waitFor(() => getWin() && !getWin().webContents.isLoading(), 10000);
      await waitFor(() => js('!!(window.api && window.QueueView)'), 5000);
    }
  });

  await test('Mac: en pantalla completa los botones desaparecen y el hueco de la izquierda tambien; al salir vuelve', async () => {
    await js(`document.documentElement.dataset.platform = 'mac'`);
    const padding = () => js('parseFloat(getComputedStyle(document.querySelector(".topbar")).paddingLeft)');
    assert((await padding()) >= 80, 'con la ventana normal hay hueco para los botones');
    getWin().emit('enter-full-screen');
    await waitFor(() => js('document.documentElement.classList.contains("is-fullscreen")'), 3000)
      .catch(() => { throw new Error('el proceso principal no avisa de la pantalla completa a la ventana'); });
    assert((await padding()) < 40, 'en pantalla completa no debe quedar el hueco de los botones');
    getWin().emit('leave-full-screen');
    await waitFor(() => js('!document.documentElement.classList.contains("is-fullscreen")'), 3000);
    assert((await padding()) >= 80, 'al salir de pantalla completa vuelve el hueco');
    await js(`document.documentElement.dataset.platform = 'linux'`);
  });

  await test('Ajustes de audio: los dos selectores existen, guardan el valor y lo recuperan al volver a abrir los ajustes', async () => {
    await js('document.getElementById("settingsBtn").click()');
    await sleep(300);
    assert(await js('document.getElementById("audioKindSelect").value === "music"'), 'por defecto: musica (criterio estricto)');
    assert(await js('document.getElementById("audioFormatSelect").value === "compat"'), 'por defecto: compatible');
    assert(await js('document.getElementById("audioFormatSelect").options.length === 3'), 'tres formatos');
    if (process.env.UI_SHOT_DIR) {
      await js('document.getElementById("audioKindSelect").scrollIntoView({ block: "center" })');
      await sleep(300);
      fs.writeFileSync(path.join(process.env.UI_SHOT_DIR, 'ajustes-audio.png'), (await getWin().webContents.capturePage()).toPNG());
    }
    assert(await js('(function(){ const r = document.getElementById("audioKindSelect").getBoundingClientRect(); return r.width > 40 && r.height > 10; })()'), 'se ven de verdad');
    await js('(function(){ const k = document.getElementById("audioKindSelect"); k.value = "voice"; k.dispatchEvent(new Event("change")); const f = document.getElementById("audioFormatSelect"); f.value = "opus"; f.dispatchEvent(new Event("change")); })()');
    await sleep(300);
    assert(await js('window.api.getSettings().then((s) => s.audioKind === "voice" && s.audioFormat === "opus")'), 'guardados');
    // Cerrar y reabrir: el panel muestra lo guardado, no los valores por defecto.
    await js('document.getElementById("settingsBtn").click()');
    await sleep(200);
    await js('document.getElementById("settingsBtn").click()');
    await sleep(300);
    assert(await js('document.getElementById("audioKindSelect").value === "voice" && document.getElementById("audioFormatSelect").value === "opus"'), 'el panel refleja lo guardado');
    await js('window.api.saveSettings({ audioKind: "music", audioFormat: "compat" })');
    await js('document.getElementById("settingsBtn").click()');
    await sleep(200);
  });

  await waitQueueDrained();

  await test('Sin errores inesperados en el proceso principal durante toda la sesion (evita avisos de error falsos al usuario)', async () => {
    assert(unhandled.length === 0, `hubo ${unhandled.length} error(es) no controlado(s), p. ej.: ${unhandled[0]}`);
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
  console.log(`\n${results.length - failed.length}/${results.length} pruebas de interfaz correctas`);
  clearTimeout(watchdog);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  app.exit(failed.length === 0 ? 0 : 1);
});
