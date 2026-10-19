'use strict';

/**
 * Cuadros de dialogo dentro de la propia app: pedir un texto y pedir
 * confirmacion.
 *
 * Por que existe: `window.prompt()` NO esta soportado en Electron (falla o
 * devuelve null sin mostrar nada), asi que "crear perfil" y "renombrar
 * perfil" no hacian absolutamente nada. `window.confirm()` si funciona, pero
 * en Windows suele dejar los campos de texto de la ventana sin poder
 * escribirse despues de cerrarse; con este cuadro propio se evita ese
 * problema y ademas se ve igual en Windows y en Mac.
 */
(function () {
  let active = null;

  function byId(id) {
    return document.getElementById(id);
  }

  /** Los elementos del cuadro (es uno solo, reutilizado para pedir un texto o confirmar). */
  function dialogElements() {
    return {
      overlay: byId('dialogOverlay'),
      titleEl: byId('dialogTitle'),
      messageEl: byId('dialogMessage'),
      inputEl: byId('dialogInput'),
      okBtn: byId('dialogOk'),
      cancelBtn: byId('dialogCancel')
    };
  }

  /** Escribe los textos y el aspecto del cuadro segun `config` y lo muestra. */
  function fillAndOpen({ overlay, titleEl, messageEl, inputEl, okBtn, cancelBtn }, config, isInput) {
    titleEl.textContent = config.title || '';
    messageEl.textContent = config.message || '';
    messageEl.classList.toggle('hidden', !config.message);
    inputEl.classList.toggle('hidden', !isInput);
    inputEl.value = config.value || '';
    inputEl.type = config.password ? 'password' : 'text'; // una contrasena no se ve mientras se escribe
    okBtn.textContent = config.okText || window.I18n.t('dialog.ok');
    cancelBtn.textContent = config.cancelText || window.I18n.t('dialog.cancel');
    okBtn.classList.toggle('btn--danger', !!config.danger);
    okBtn.classList.toggle('btn--primary', !config.danger);
    overlay.classList.remove('hidden');
  }

  /** Tab / Mayus+Tab dan la vuelta dentro del cuadro: el foco no se escapa a lo de atras. */
  function trapTab(e, { inputEl, cancelBtn, okBtn }) {
    const focusables = [inputEl, cancelBtn, okBtn].filter((el) => !el.classList.contains('hidden'));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function show(config) {
    // Si ya habia uno abierto, se cancela antes de abrir el nuevo.
    if (active) active.close(active.isInput ? null : false);

    const elements = dialogElements();
    const { overlay, inputEl, okBtn, cancelBtn } = elements;
    const previousFocus = document.activeElement;
    const isInput = !!config.input;
    fillAndOpen(elements, config, isInput);

    return new Promise((resolve) => {
      let finished = false;

      function close(result) {
        if (finished) return;
        finished = true;
        overlay.classList.add('hidden');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('keydown', onKeyDown);
        overlay.removeEventListener('mousedown', onBackdrop);
        active = null;
        if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
        resolve(result);
      }

      function onOk() {
        if (isInput) {
          // Una contrasena se respeta tal cual (puede llevar espacios al principio o al final); un nombre, no.
          const value = config.password ? inputEl.value : inputEl.value.trim();
          if (!value) {
            inputEl.focus();
            return;
          }
          close(value);
        } else {
          close(true);
        }
      }

      function onCancel() {
        close(isInput ? null : false);
      }

      function onBackdrop(e) {
        if (e.target === overlay) onCancel();
      }

      function onKeyDown(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation(); // que no cierre tambien el panel de Ajustes de atras
          onCancel();
        } else if (e.key === 'Enter' && e.target === inputEl) {
          e.preventDefault();
          e.stopPropagation();
          onOk();
        } else if (e.key === 'Tab') {
          trapTab(e, elements);
        }
      }

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      overlay.addEventListener('keydown', onKeyDown);
      overlay.addEventListener('mousedown', onBackdrop);

      active = { close, isInput };
      if (isInput) {
        inputEl.focus();
        inputEl.select();
      } else {
        okBtn.focus();
      }
    });
  }

  /** Pide un texto. Devuelve el texto escrito, o null si se cancela. */
  function prompt({ title, message, value, okText, cancelText, password }) {
    return show({ title, message, value, okText, cancelText, input: true, password });
  }

  /** Pide confirmacion. Devuelve true / false. */
  function confirm({ title, message, okText, cancelText, danger }) {
    return show({ title, message, okText, cancelText, danger, input: false });
  }

  function isOpen() {
    return !byId('dialogOverlay').classList.contains('hidden');
  }

  window.Dialog = { prompt, confirm, isOpen };
})();
