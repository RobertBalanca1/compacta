'use strict';

/**
 * Idioma de la app en el proceso principal. El idioma elegido en Ajustes (o, si esta en "automatico", el del
 * sistema operativo) se aplica al modulo compartido `src/shared/i18n.js`, que usan los avisos y errores que
 * redacta este proceso. La ventana lo pide con `language:get` y aplica el mismo idioma a la interfaz.
 */

const i18n = require('../shared/i18n');
const { loadSettings } = require('./settings-store');

/** Idiomas del sistema, del preferido al menos preferido ([] fuera de Electron, p. ej. en pruebas). */
function systemLocales() {
  try {
    const { app } = require('electron');
    const preferred = typeof app.getPreferredSystemLanguages === 'function' ? app.getPreferredSystemLanguages() : [];
    return [app.getLocale(), ...preferred].filter(Boolean);
  } catch {
    return [];
  }
}

/** Lee el ajuste, decide el idioma y lo aplica. Devuelve el codigo aplicado. */
function applyLanguage() {
  return i18n.setLanguage(i18n.resolveLanguage(loadSettings().language, systemLocales()));
}

/** Lo que necesita la ventana para ponerse en el idioma correcto y rellenar el selector de Ajustes. */
function describeLanguage() {
  return { language: i18n.getLanguage(), setting: loadSettings().language, languages: i18n.LANGUAGES };
}

module.exports = { applyLanguage, describeLanguage, systemLocales };
