'use strict';

/**
 * Soporta pegar (Ctrl/Cmd+V) imagenes en la ventana, de dos formas:
 *  - Archivos reales copiados (por ejemplo, desde el explorador de
 *    Windows/Finder): se reutiliza el mismo camino que arrastrar y soltar.
 *  - Datos de imagen crudos sin archivo de origen (por ejemplo, una
 *    captura de pantalla copiada directo): se envian los bytes al proceso
 *    principal, que los guarda como un archivo nuevo antes de procesarlos.
 */
(function () {
  const MIME_TO_EXTENSION = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/tiff': '.tif'
  };

  function extensionFromMime(mimeType) {
    return MIME_TO_EXTENSION[mimeType] || '.png';
  }

  async function handlePaste(event, { onImported, onError }) {
    const files = Array.from(event.clipboardData ? event.clipboardData.files : []);
    if (files.length === 0) return;

    const realPaths = [];
    const rawImages = [];

    for (const file of files) {
      let realPath = null;
      try {
        realPath = window.api.getPathForFile(file);
      } catch {
        realPath = null;
      }

      if (realPath) {
        realPaths.push(realPath);
      } else if (file.type && file.type.startsWith('image/')) {
        const arrayBuffer = await file.arrayBuffer();
        rawImages.push({ bytes: new Uint8Array(arrayBuffer), extension: extensionFromMime(file.type) });
      }
    }

    if (realPaths.length === 0 && rawImages.length === 0) return;

    try {
      let result = null;
      if (realPaths.length > 0) {
        result = await window.api.importFiles(realPaths);
      }
      let rawResult = null;
      for (const img of rawImages) {
        rawResult = await window.api.importClipboardImage(img.bytes, img.extension);
      }
      // Si lo pegado era un duplicado, se avisa (antes no se decia nada).
      if (onImported) onImported(result || rawResult);
    } catch (err) {
      if (onError) onError(err);
    }
  }

  function init({ onImported, onError }) {
    document.addEventListener('paste', (event) => {
      handlePaste(event, { onImported, onError });
    });
  }

  window.ClipboardImport = { init };
})();
