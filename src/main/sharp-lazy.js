'use strict';

/**
 * `sharp` (libvips, un modulo nativo grande) se carga la PRIMERA vez que se necesita, y no al arrancar
 * la app: cargarlo retrasaba la aparicion de la ventana (medido: ~65 ms en un disco rapidisimo; en
 * Windows, con el antivirus revisando la libreria nativa, mucho mas). La app lo calienta justo despues de
 * dibujar la ventana (`warmSharp`), asi que cuando llega la primera foto ya esta cargado.
 */

let instance = null;

function getSharp() {
  if (!instance) {
    instance = require('sharp');
    // Le decimos a sharp/libvips que NO reparta un mismo archivo entre varios
    // hilos internos. La paralelizacion la controla nuestra cola (queue-manager)
    // procesando varias imagenes distintas a la vez; si ademas cada imagen
    // intentara usar todos los nucleos por su cuenta, se pisarian entre si y el
    // lote completo iria mas lento, no mas rapido.
    instance.concurrency(1);
    // La cache de sharp guarda descriptores de archivo abiertos de las ultimas
    // fotos leidas. En un lote cada foto se lee UNA sola vez, asi que esa cache
    // solo retiene archivos abiertos (en Windows, impidiendo borrarlos o
    // moverlos) sin ahorrar nada. Se desactiva la de archivos y se deja una
    // pequeña de memoria.
    instance.cache({ files: 0, memory: 50, items: 100 });
  }
  return instance;
}

/** Carga sharp ahora (sin fallar: si no se puede, el error saldra al procesar la primera foto, con su aviso). */
function warmSharp() {
  try {
    getSharp();
  } catch {
    // se vera al procesar
  }
}

module.exports = { getSharp, warmSharp };
