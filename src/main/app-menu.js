'use strict';

const { t } = require('../shared/i18n');

/**
 * Menu de la aplicacion en macOS.
 *
 * Por que hace falta uno propio: sin el, Electron pone su menu de ejemplo, que en la app ya instalada trae
 * «Ver > Herramientas de desarrollo» y los textos en el idioma del sistema, no en el que la persona eligio en
 * Ajustes. Y el menu «Edicion» es IMPRESCINDIBLE en Mac: ⌘C, ⌘V, ⌘X y ⌘Z no existen como teclas por si solas,
 * son atajos de ese menu; sin el no se podria ni pegar una foto del portapapeles (⌘V) ni copiar el texto de un aviso.
 *
 * En Windows y Linux no hay menu (ver `refreshAppMenu`): este solo se instala en macOS.
 *
 * `buildMenuTemplate` es una funcion pura (datos -> plantilla): se prueba sin Mac. Las etiquetas salen de
 * i18n, asi que siguen el idioma de la app, y se reconstruye cuando se cambia ese idioma (`refreshAppMenu`).
 */

/**
 * @param {object} options
 * @param {string}   options.appName       nombre que se muestra en el menu de la app («Compacta»)
 * @param {function} options.translate     t(clave, parametros)
 * @param {function} [options.openOutput]  abre la carpeta de salida (Archivo > Abrir carpeta de salida)
 * @param {boolean}  [options.devTools]    solo en `npm run dev`: añade «Herramientas de desarrollo» a Visualizacion
 */
function buildMenuTemplate({ appName, translate, openOutput, devTools = false }) {
  const label = (key, params) => translate(`menu.${key}`, params);
  const app = { app: appName };

  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: label('about', app) },
        { type: 'separator' },
        { role: 'hide', label: label('hide', app) },
        { role: 'hideOthers', label: label('hideOthers') },
        { role: 'unhide', label: label('showAll') },
        { type: 'separator' },
        { role: 'quit', label: label('quit', app) }
      ]
    },
    {
      label: label('file'),
      submenu: [
        { label: label('openOutput'), accelerator: 'Shift+CommandOrControl+O', click: () => { if (openOutput) openOutput(); } },
        { type: 'separator' },
        { role: 'close', label: label('closeWindow') }
      ]
    },
    {
      label: label('edit'),
      submenu: [
        { role: 'undo', label: label('undo') },
        { role: 'redo', label: label('redo') },
        { type: 'separator' },
        { role: 'cut', label: label('cut') },
        { role: 'copy', label: label('copy') },
        { role: 'paste', label: label('paste') },
        { role: 'selectAll', label: label('selectAll') }
      ]
    },
    {
      label: label('view'),
      submenu: [
        { role: 'togglefullscreen', label: label('fullscreen') },
        ...(devTools ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : [])
      ]
    },
    {
      label: label('window'),
      role: 'window',
      submenu: [
        { role: 'minimize', label: label('minimize') },
        { role: 'zoom', label: label('zoom') },
        { type: 'separator' },
        { role: 'front', label: label('front') }
      ]
    }
  ];
}

/**
 * Instala (o reinstala, tras cambiar de idioma) el menu de la aplicacion.
 *  - macOS: el menu propio de arriba.
 *  - Windows y Linux: SIN menu. Sin esta orden Electron enseña su menu de ejemplo (Archivo, Edicion, Ver, Ventana, Ayuda) con
 *    «Herramientas de desarrollo» y «Recargar» a la vista de cualquiera; la app no necesita ninguno (copiar/pegar y deshacer
 *    funcionan solos dentro de los campos de texto, y «pegar una imagen» es el evento normal de pegado).
 *  - En desarrollo (`npm run dev`) se deja el de Electron, que trae las herramientas de desarrollo.
 * Devuelve si instalo o quito algo. `electron` y `devTools` se inyectan en las pruebas.
 */
function refreshAppMenu({ platform = process.platform, electron = null, devTools = process.argv.includes('--dev') } = {}) {
  if (devTools && platform !== 'darwin') return false;
  const { app, Menu, shell } = electron || require('electron');
  if (platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return true;
  }
  const { getOutputDir } = require('./paths');
  const template = buildMenuTemplate({
    appName: app.name || 'Compacta',
    translate: t,
    openOutput: () => { shell.openPath(getOutputDir()); },
    devTools
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  return true;
}

module.exports = { buildMenuTemplate, refreshAppMenu };
