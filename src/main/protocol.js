'use strict';

const { protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { getBaseDir } = require('./paths');

const SCHEME = 'compacta-file';

// El "host" de la URL es siempre este valor fijo. Antes las URLs eran
// `compacta-file:///input/Lote/foto.jpg`, y Chromium las reescribe como
// `compacta-file://input/Lote/foto.jpg` tratando "input" como el host: el
// manejador perdia ese primer tramo, buscaba `Documentos/Compacta/Lote/foto.jpg`
// (que no existe) y NINGUNA miniatura de la cola llegaba a cargar jamas
// (net::ERR_FILE_NOT_FOUND). Con un host fijo, la ruta completa queda intacta
// en `pathname`.
const HOST = 'app';

/** Debe llamarse ANTES de app.whenReady(). */
function registerSchemeAsPrivileged() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ]);
}

/**
 * Resuelve `relativePath` dentro de `baseDir`; devuelve null si el resultado
 * se sale de esa carpeta. Se compara contra `baseDir + separador`, no solo
 * contra `baseDir`: un simple startsWith(baseDir) aceptaba tambien carpetas
 * hermanas como `Compacta-otra` (path traversal por prefijo).
 */
function resolveInsideBase(baseDir, relativePath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relativePath);
  if (target === base || target.startsWith(base + path.sep)) return target;
  return null;
}

/** Debe llamarse DESPUES de app.whenReady(). Sirve archivos solo dentro de la carpeta base de la app. */
function registerProtocolHandler() {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const targetPath = resolveInsideBase(getBaseDir(), relativePath);
      if (!targetPath) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(targetPath).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/**
 * Convierte una ruta absoluta (dentro de la carpeta base) en una URL segura
 * para el renderer. Cada tramo se codifica por separado: encodeURI dejaba
 * sin codificar `#` y `?`, asi que una foto llamada "cumple #1.jpg" se cortaba
 * en el `#` y no cargaba.
 *
 * Sin uso propio por ahora (la miniatura de la cola se quito, ver
 * DOCUMENTACION-PROYECTO.md 7.11) -- se conserva para la vista previa
 * antes/despues a tamaño completo de MEJORAS.md, que si necesitara servir
 * la imagen entera de forma segura.
 */
function toSafeFileUrl(absolutePath) {
  const relative = path.relative(getBaseDir(), absolutePath).split(path.sep).map(encodeURIComponent).join('/');
  return `${SCHEME}://${HOST}/${relative}`;
}

module.exports = { registerSchemeAsPrivileged, registerProtocolHandler, toSafeFileUrl, resolveInsideBase };
