'use strict';

/**
 * Idiomas de Compacta. UN solo modulo que usan por igual el proceso principal (con `require`) y la ventana
 * (con una etiqueta <script>): los avisos, errores y notificaciones que redacta el proceso principal salen
 * en el mismo idioma que la interfaz.
 *
 * Idiomas: español, inglés, alemán, italiano, vietnamita y árabe (este, de derecha a izquierda).
 *
 * Como funciona:
 *  - Los textos viven en `locales/<codigo>.js`, uno por idioma, con las MISMAS claves. El español es la
 *    fuente: lo que falte en otro idioma se muestra en inglés y, si tampoco esta, en español (nunca
 *    una clave pelada). Una prueba comprueba que ningun idioma pierde claves ni cambia los {parametros}.
 *  - `t('clave', { n: 3 })` sustituye {n}. Con `count` elige la forma plural segun el idioma
 *    (`clave.one`, `clave.other`, y en arabe tambien `.two`, `.few`, `.many`; `Intl.PluralRules`).
 *  - El idioma inicial sale del sistema operativo (`resolveLanguage`); la persona puede cambiarlo en Ajustes
 *    sin reinstalar. Por defecto, en pruebas y antes de elegir, es el español.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const dictionaries = {};
    for (const code of ['es', 'en', 'de', 'it', 'vi', 'ar']) dictionaries[code] = require(`./locales/${code}.js`);
    module.exports = factory(dictionaries);
  } else {
    root.I18n = factory(root.CompactaLocales || {});
  }
})(typeof self !== 'undefined' ? self : this, function (dictionaries) {
  const LANGUAGES = [
    { code: 'es', name: 'Español', dir: 'ltr' },
    { code: 'en', name: 'English', dir: 'ltr' },
    { code: 'de', name: 'Deutsch', dir: 'ltr' },
    { code: 'it', name: 'Italiano', dir: 'ltr' },
    { code: 'vi', name: 'Tiếng Việt', dir: 'ltr' },
    { code: 'ar', name: 'العربية', dir: 'rtl' }
  ];
  const CODES = LANGUAGES.map((language) => language.code);
  const FALLBACK = 'en';
  const SOURCE = 'es';

  let current = SOURCE;

  /** Codigo de idioma de una etiqueta del sistema ("es-ES", "ar_SA", "vi") o null si no esta soportado. */
  function codeOf(locale) {
    const primary = String(locale || '').toLowerCase().split(/[-_]/)[0];
    return CODES.includes(primary) ? primary : null;
  }

  /**
   * Idioma a usar: el elegido en Ajustes si es valido; si no (automatico), el primero soportado de los
   * idiomas del sistema; y si ninguno lo esta, inglés. Funcion pura.
   */
  function resolveLanguage(chosen, systemLocales = []) {
    if (CODES.includes(chosen)) return chosen;
    for (const locale of systemLocales) {
      const code = codeOf(locale);
      if (code) return code;
    }
    return FALLBACK;
  }

  function setLanguage(code) {
    current = CODES.includes(code) ? code : SOURCE;
    return current;
  }

  const getLanguage = () => current;
  const directionOf = (code = current) => (LANGUAGES.find((language) => language.code === code) || LANGUAGES[0]).dir;

  function lookup(key, code) {
    const dictionary = dictionaries[code];
    return dictionary && Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : undefined;
  }

  /** Busca la clave en el idioma actual, luego en inglés, luego en español; null si no existe en ninguno. */
  function find(key) {
    for (const code of [current, FALLBACK, SOURCE]) {
      const text = lookup(key, code);
      if (text !== undefined) return { text, code };
    }
    return null;
  }

  function t(key, params) {
    const count = params && typeof params.count === 'number' ? params.count : null;
    let found = null;
    if (count !== null) {
      for (const code of [current, FALLBACK, SOURCE]) {
        let category = 'other';
        try {
          category = new Intl.PluralRules(code).select(count);
        } catch {
          // Intl no conoce el idioma: forma generica
        }
        const text = lookup(`${key}.${category}`, code) ?? lookup(`${key}.other`, code);
        if (text !== undefined) {
          found = { text };
          break;
        }
      }
    }
    if (!found) found = find(key);
    if (!found) return key;
    return String(found.text).replace(/\{(\w+)\}/g, (whole, name) => (params && name in params ? String(params[name]) : whole));
  }

  /**
   * Pone los textos de una pagina HTML: data-i18n (texto), data-i18n-title, data-i18n-aria (aria-label),
   * data-i18n-alt. Tambien fija `lang` y `dir` del documento (el arabe se lee de derecha a izquierda).
   */
  function applyTranslations(doc = document) {
    doc.documentElement.lang = current;
    doc.documentElement.dir = directionOf();
    const attributes = [['data-i18n-title', 'title'], ['data-i18n-aria', 'aria-label'], ['data-i18n-alt', 'alt']];
    for (const element of doc.querySelectorAll('[data-i18n]')) element.textContent = t(element.getAttribute('data-i18n'));
    for (const [dataAttribute, attribute] of attributes) {
      for (const element of doc.querySelectorAll(`[${dataAttribute}]`)) element.setAttribute(attribute, t(element.getAttribute(dataAttribute)));
    }
  }

  /**
   * Un trozo que debe leerse de izquierda a derecha aunque vaya dentro de una frase de derecha a izquierda
   * (un tamano «2.1 MB», «281 B → 120 B», unas medidas): sin esto, el algoritmo bidireccional del texto lo
   * desordena («B 0» en vez de «0 B»). Se aisla con marcas Unicode invisibles; en los idiomas de izquierda a
   * derecha no hace nada.
   */
  function isolate(text) {
    return directionOf() === 'rtl' ? `\u2066${text}\u2069` : String(text);
  }

  return { LANGUAGES, CODES, t, setLanguage, getLanguage, directionOf, isolate, resolveLanguage, codeOf, applyTranslations };
});
