'use strict';

const os = require('os');

const GIB = 1024 ** 3;

/**
 * Cuantas imagenes procesar en paralelo. Cada trabajo es 100% independiente
 * (su propio archivo de entrada y salida, sin estado compartido), asi que el
 * paralelismo acotado es seguro: no hay condicion de carrera posible entre
 * trabajos.
 *
 * El limite lo ponen DOS cosas, la menor de las dos:
 *  - Nucleos: todos menos uno (se deja uno libre para la interfaz y el
 *    sistema), entre 1 y 8. Antes el tope era 4 aunque la maquina tuviera 12
 *    nucleos, y la mitad del procesador se quedaba sin usar.
 *  - Memoria: aproximadamente 1 trabajo por cada 2 GiB de RAM. Decodificar
 *    una foto de 50-100 megapixeles ocupa cientos de MB; sin este limite, una
 *    maquina con muchos nucleos y poca RAM empezaria a usar disco como memoria
 *    y el lote iria MAS lento, no mas rapido.
 */
function getDefaultConcurrency() {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : (os.cpus().length || 2);
  const byCpu = cores - 1;
  const byMemory = Math.floor(os.totalmem() / (2 * GIB));
  return Math.max(1, Math.min(8, byCpu, Math.max(1, byMemory)));
}

module.exports = { getDefaultConcurrency };
