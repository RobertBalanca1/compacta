'use strict';

/**
 * Registro de los procesos externos que lanza la app (ffmpeg, tar) para poder
 * matarlos todos al cerrar: si no, un video a medias o una descompresion
 * enorme seguirian trabajando con la ventana ya cerrada.
 */

const running = new Set();

/** Apunta un proceso hijo y lo olvida solo cuando termina. */
function track(child) {
  running.add(child);
  const forget = () => running.delete(child);
  child.once('close', forget);
  child.once('error', forget);
  return child;
}

function killAllChildren() {
  for (const child of running) child.kill();
  running.clear();
}

module.exports = { track, killAllChildren };
