'use strict';

(function () {
  let toastTimer = null;
  const t = (key, params) => window.I18n.t(key, params);

  /** kind: 'error' (por defecto, rojo) o 'ok' (verde, para avisos de exito). */
  function showToast(message, kind) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.toggle('toast--ok', kind === 'ok');
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), kind === 'ok' ? 7000 : 5000);
  }

  async function safely(promise, fallbackMessage) {
    try {
      return await promise;
    } catch (err) {
      console.error(err);
      if (fallbackMessage) showToast(fallbackMessage);
      return null;
    }
  }

  /**
   * Lo omitido por repetido se dice en un aviso que SE QUEDA (un toast de 5 s se perdia: se veia como
   * que soltar archivos "no hacia nada"). Si se conoce de donde venian, ofrece procesarlos igualmente.
   */
  function showDuplicatesNotice(result) {
    const inDrop = result.duplicateInDrop || 0;
    const before = result.duplicateBefore || 0;
    if (!inDrop && !before) return;
    const parts = [];
    if (inDrop) parts.push(t('dup.inDrop', { count: inDrop }));
    if (before) parts.push(t('dup.before', { count: before }));
    parts.push(t('dup.neverSimilar'));
    document.getElementById('duplicatesNoticeText').textContent = parts.join(' ');
    document.getElementById('importSkippedBtn').classList.toggle('hidden', !(result.duplicateRetryable > 0));
    document.getElementById('duplicatesNotice').classList.remove('hidden');
  }

  function hideDuplicatesNotice() {
    document.getElementById('duplicatesNotice').classList.add('hidden');
  }

  /**
   * Avisos tras una importacion. Los problemas se juntan en UN solo mensaje
   * (un toast sustituye al anterior, asi que varios seguidos se pisarian).
   */
  function notifyImportResult(result) {
    if (!result || result.canceled) return;
    const problems = [];

    if (result.outputFellBackFrom) {
      problems.push(t('import.outputFellBack', { dir: result.outputFellBackFrom }));
    }
    if (result.outputDir) refreshOutputDir();

    const failedArchives = result.failedArchives || [];
    if (failedArchives.length > 0) {
      problems.push(failedArchives.slice(0, 2).map((z) => t('import.archiveFailed', { name: z.name, reason: z.reason })).join(' ')
        + (failedArchives.length > 2 ? t('import.archiveMore', { n: failedArchives.length - 2 }) : ''));
    }

    if (result.skippedCount) {
      problems.push(t('import.skipped', { count: result.skippedCount }));
    }

    if (result.failedCount) {
      problems.push(t('import.failedCopy', { count: result.failedCount }));
    }

    showDuplicatesNotice(result);

    if (problems.length > 0) {
      showToast(problems.join(' '));
    } else if (result.importedCount === 0 && !result.duplicateCount) {
      showToast(t('import.nothing'));
    }
  }

  // ----- Estado "importando" (copiar carpetas grandes / descomprimir ZIP) -----
  // Contador y no booleano: pueden solaparse varias importaciones.
  let importsRunning = 0;
  let importUiActive = false; // false mientras solo esta abierto el selector del sistema
  let lastImportCount = 0;

  /** En Mac se pega con Cmd+V, no con Ctrl+V. */
  const pasteShortcut = () => (window.api.platform === 'darwin' ? '⌘V' : 'Ctrl+V');

  function setImportingUi(count) {
    lastImportCount = count;
    const dropzone = document.getElementById('dropzone');
    const subtitle = document.getElementById('dropzoneSubtitle');
    const busy = importsRunning > 0 && importUiActive;
    dropzone.classList.toggle('busy', busy);
    dropzone.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (busy) {
      subtitle.textContent = count > 0 ? t('dropzone.busyCount', { count }) : t('dropzone.busyReading');
    } else {
      subtitle.textContent = t('dropzone.subtitle', { shortcut: pasteShortcut() });
    }
  }

  // ----- Carpeta de salida: pie de pagina y Ajustes -----
  /** Muestra la carpeta de salida vigente (la de siempre se escribe corta y legible). */
  let lastOutputInfo = null;

  function showOutputDir(info) {
    lastOutputInfo = info;
    const label = info.isDefault ? t('footer.defaultPath') : info.dir;
    const hint = document.getElementById('folderHintPath');
    hint.textContent = label;
    hint.title = info.dir;
    document.getElementById('outputDirValue').textContent = info.dir;
    document.getElementById('resetOutputBtn').disabled = info.isDefault;
  }

  async function refreshOutputDir() {
    const info = await safely(window.api.getOutputInfo(), t('err.readOutput'));
    if (info) showOutputDir(info);
  }

  /**
   * Ejecuta una importacion mostrando el estado "importando" mientras dura.
   * Con `viaDialog`, el estado solo aparece cuando el proceso principal avisa
   * de que ya se eligio algo (mientras el selector del sistema esta abierto
   * no se esta importando nada, y decir "Importando…" seria mentira).
   */
  /** Igual que antes, pero un ZIP con contrasena NO se da por fallido: se pide la contrasena y se reintenta ese comprimido. */
  async function runImport(startImport, errorMessage, options) {
    const result = await runImportOnce(startImport, errorMessage, options);
    await unlockArchives(result);
    return result;
  }

  /** El resultado sin los comprimidos que se van a pedir con contrasena (de esos avisa el cuadro, no el aviso general). */
  const withoutLocked = (result) => (result && result.failedArchives
    ? { ...result, failedArchives: result.failedArchives.filter((z) => !z.needsPassword) }
    : result);

  /**
   * Cada ZIP con contrasena: se pregunta, se reintenta SOLO ese comprimido y, si la contrasena no era, se vuelve a
   * preguntar hasta que acierte o la persona cancele. Si cancela, queda avisado como siempre («protegido con contrasena»).
   */
  async function unlockArchives(result) {
    for (const first of ((result && result.failedArchives) || []).filter((z) => z.needsPassword)) {
      let current = first;
      while (current) {
        const password = await window.Dialog.prompt({
          title: t('password.title'),
          message: t(current.wrongPassword ? 'password.wrong' : 'password.message', { name: current.name }),
          okText: t('password.open'),
          password: true
        });
        if (!password) {
          showToast(t('import.archiveFailed', { name: current.name, reason: current.reason }));
          break;
        }
        const retry = await safely(window.api.importArchiveWithPassword(current.archivePath, password), t('err.import'));
        if (!retry) break;
        const again = (retry.failedArchives || []).find((z) => z.needsPassword);
        if (!again) notifyImportResult(retry);
        current = again;
      }
    }
  }

  async function runImportOnce(startImport, errorMessage, { viaDialog = false } = {}) {
    importsRunning += 1;
    hideDuplicatesNotice(); // el aviso de la importacion anterior ya no corresponde
    if (!viaDialog) importUiActive = true;
    setImportingUi(0);
    try {
      const result = await safely(startImport(), errorMessage);
      notifyImportResult(withoutLocked(result));
      return result;
    } finally {
      importsRunning -= 1;
      if (importsRunning === 0) importUiActive = false;
      setImportingUi(0);
    }
  }

  /**
   * ¿El foco esta en un campo que YA usa la barra espaciadora para lo suyo
   * (escribir texto, mover un slider, abrir un desplegable...)? Solo en ese
   * caso el atajo global debe apartarse; para cualquier otra cosa (incluidos
   * los botones) el espacio siempre debe significar Detener/Reanudar.
   *
   * Antes esto tambien excluia CUALQUIER <button, [tabindex], [role="button"]>,
   * pensando que "ya reacciona solo al espacio". El problema es que Chromium
   * (a diferencia de Firefox/Safari) deja el foco en el ULTIMO boton pulsado
   * con el raton -- por ejemplo, en "Elegir carpeta" justo despues de elegir
   * una carpeta. Con la exclusion anterior, la siguiente vez que se pulsaba
   * espacio para Detener/Reanudar, el atajo global se apartaba (por ser un
   * <button>) y el espacio quedaba libre para su comportamiento nativo:
   * volver a activar ESE MISMO boton. Resultado real reportado: pulsar
   * espacio para detener la cola volvia a abrir el selector de carpeta/
   * archivos (el que se hubiera tocado por ultima vez), sin avisar y sin
   * relacion con lo que se queria hacer.
   *
   * Ahora los botones ya NO se excluyen aqui: mas abajo se les hace
   * preventDefault() para anular ese clic nativo por espacio, y el atajo
   * actua siempre igual sin importar en que boton quedo el foco.
   */
  function isTypingTarget(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (el.isContentEditable) return true;
    return !!el.closest('input, select, textarea');
  }

  function togglePauseFromKeyboard() {
    const btn = document.getElementById('pauseResumeBtn');
    if (btn.classList.contains('hidden')) return;
    if (btn.dataset.action === 'resume') {
      safely(window.api.resumeQueue(), t('err.resume'));
    } else {
      safely(window.api.pauseQueue(), t('err.pause'));
    }
  }

  let languageState = null;

  /** Pone toda la interfaz en `code`: textos fijos del HTML, y los que se escriben desde el codigo. */
  function applyLanguage(code) {
    window.I18n.setLanguage(code);
    window.I18n.applyTranslations(document);
    setImportingUi(lastImportCount);
    if (lastOutputInfo) showOutputDir(lastOutputInfo);
    window.QueueView.refresh();
  }

  /** Panel de Ajustes: perfiles, idioma y el resto de ajustes de compresión. */
  async function setupSettings() {
    const settings = await window.api.getSettings();
    const panel = window.SettingsPanel.init({
      onChange: (partial) => safely(window.api.saveSettings(partial), t('err.saveSetting')),
      onProfileCreate: async (name) => {
        const next = await safely(window.api.createProfile(name), t('err.profileCreate'));
        if (next) panel.setValues(next);
      },
      onProfileRename: async (id, name) => {
        const next = await safely(window.api.renameProfile(id, name), t('err.profileRename'));
        if (next) panel.setValues(next);
      },
      onProfileDelete: async (id) => {
        const next = await safely(window.api.deleteProfile(id), t('err.profileDelete'));
        if (next) panel.setValues(next);
      },
      onProfileSwitch: async (id) => {
        const next = await safely(window.api.switchProfile(id), t('err.profileSwitch'));
        if (next) panel.setValues(next);
      },
      onLanguageChange: async (code) => {
        // Se guarda; el proceso principal aplica el idioma (para sus avisos) y la ventana lo lee de vuelta.
        if (!(await safely(window.api.saveSettings({ language: code }), t('err.saveSetting')))) return;
        languageState = await window.api.getLanguage();
        applyLanguage(languageState.language);
        panel.setLanguageState(languageState);
        panel.refreshTexts();
      }
    });
    panel.setLanguageState(languageState);
    panel.setValues(settings);
  }

  /** Todo lo que mete archivos a la cola: arrastrar, pegar, los tres botones de elegir, «Procesar de todos modos» y «Eliminar pendientes». */
  function setupImportControls() {
    window.Dropzone.init({
      onFilesDropped: (paths) => runImport(
        () => window.api.importFiles(paths),
        t('err.import')
      )
    });

    window.ClipboardImport.init({
      onImported: (result) => notifyImportResult(result),
      onError: () => showToast(t('err.paste'))
    });

    document.getElementById('pauseResumeBtn').addEventListener('click', togglePauseFromKeyboard);
    document.getElementById('dismissDuplicatesBtn').addEventListener('click', hideDuplicatesNotice);
    document.getElementById('importSkippedBtn').addEventListener('click', () => runImport(
      () => window.api.importSkipped(), t('err.importSkipped')
    ));

    document.getElementById('cancelPendingBtn').addEventListener('click', async () => {
      const confirmed = await window.Dialog.confirm({
        title: t('confirm.cancelPending.title'),
        message: t('confirm.cancelPending.message'),
        okText: t('dialog.delete'),
        danger: true
      });
      if (!confirmed) return;
      safely(window.api.cancelPending(), t('err.cancelPending'));
    });

    document.getElementById('chooseFilesBtn').addEventListener('click', () => runImport(
      () => window.api.selectFiles(), t('err.pickFiles'), { viaDialog: true }
    ));
    document.getElementById('chooseFolderBtn').addEventListener('click', () => runImport(
      () => window.api.selectFolder(), t('err.pickFolder'), { viaDialog: true }
    ));
    document.getElementById('chooseArchiveBtn').addEventListener('click', () => runImport(
      () => window.api.selectArchive(), t('err.pickArchive'), { viaDialog: true }
    ));
  }

  /** Carpeta de salida (cambiar, restablecer, abrir) y limpiar la lista. */
  function setupOutputControls() {
    document.getElementById('chooseOutputBtn').addEventListener('click', async () => {
      const result = await safely(window.api.chooseOutputDir(), t('err.changeOutput'));
      if (!result || result.canceled) return;
      if (!result.ok) {
        showToast(result.reason);
        return;
      }
      showOutputDir(result);
      showToast(t('toast.outputChanged', { dir: result.dir }));
    });
    document.getElementById('resetOutputBtn').addEventListener('click', async () => {
      const result = await safely(window.api.resetOutputDir(), t('err.resetOutput'));
      if (!result) return;
      showOutputDir(result);
      showToast(t('toast.outputReset'));
    });
    refreshOutputDir();
    document.getElementById('openOutputBtn').addEventListener('click', () => safely(
      window.api.openOutputFolder(),
      t('err.openOutput')
    ));
    document.getElementById('clearFinishedBtn').addEventListener('click', () => safely(
      window.api.clearFinished(),
      t('err.clearList')
    ));
  }

  /** Aviso de carpeta sincronizada con la nube (OneDrive/iCloud). */
  async function setupCloudBanner() {
    const cloudCheck = await safely(window.api.checkCloudSync(), null);
    if (cloudCheck && cloudCheck.cloudSynced && !cloudCheck.dismissed) {
      document.getElementById('cloudSyncBanner').classList.remove('hidden');
    }
    document.getElementById('dismissCloudBannerBtn').addEventListener('click', () => {
      document.getElementById('cloudSyncBanner').classList.add('hidden');
      safely(window.api.dismissCloudWarning(), null);
    });
  }

  /** Atajo de teclado: la barra espaciadora alterna Detener/Reanudar. */
  function setupSpaceShortcut() {
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (isTypingTarget(e.target)) return;
      if (window.Dialog.isOpen()) return;
      if (!document.getElementById('settingsOverlay').classList.contains('hidden')) return;
      // Con la vista previa abierta, el espacio no debe pausar la cola por detras.
      if (!document.getElementById('previewOverlay').classList.contains('hidden')) return;
      // La zona de arrastrar tiene su propio manejador para activarse (como
      // corresponde a su role="button") cuando ELLA MISMA tiene el foco; ese
      // caso se deja pasar tal cual para no duplicar la accion. Pero un
      // boton DENTRO de ella (Elegir archivos/carpeta) no cuenta como "la
      // zona de arrastrar tiene el foco" -- ver el comentario de arriba.
      if (e.target === document.getElementById('dropzone')) return;
      // preventDefault() aqui es lo que evita que, si el foco quedo en
      // cualquier boton (el que sea), el espacio ADEMAS dispare el clic
      // nativo de ese boton.
      e.preventDefault();
      togglePauseFromKeyboard();
    });
  }

  async function main() {
    // El sistema operativo, tambien ANTES de dibujar: en Mac la barra superior deja sitio a los botones de la ventana.
    document.documentElement.dataset.platform = { darwin: 'mac', win32: 'windows' }[window.api.platform] || 'linux';
    window.api.onFullScreenChange((on) => document.documentElement.classList.toggle('is-fullscreen', on));

    // El idioma, ANTES de dibujar nada: asi no se ve un instante en el idioma equivocado.
    languageState = await window.api.getLanguage();
    applyLanguage(languageState.language);

    // Los avisos y la cola se enganchan lo primero: si se hiciera despues de
    // los "await" de abajo, se perderian los eventos que lleguen mientras tanto.
    window.api.onAppError((message) => showToast(message));
    window.api.onBatchFinished((message) => {
      showToast(`✓ ${message}`, 'ok');
      window.CompletionSound.play();
    });
    window.api.onQueueUpdate((snapshot) => window.QueueView.render(snapshot));
    window.api.onImportProgress((count) => {
      if (importsRunning > 0) {
        importUiActive = true;
        setImportingUi(count);
      }
    });

    await setupSettings();
    setupImportControls();
    setupOutputControls();
    window.QueueView.render(await window.api.getQueueSnapshot());
    await setupCloudBanner();
    setupSpaceShortcut();
  }

  document.addEventListener('DOMContentLoaded', () => {
    main().catch((err) => {
      console.error(err);
      showToast(window.I18n.t('err.startup'));
    });
  });
})();
