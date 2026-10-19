'use strict';

const fs = require('fs/promises');
const path = require('path');
const { isSidecarOf, sidecarSuffix } = require('./formats');
const { copyOriginal } = require('./output-files');

/**
 * Subtitulos en archivo aparte: se copian junto a la salida del video, con el
 * nombre de la SALIDA (el video puede cambiar de extension o de nombre, y el
 * subtitulo tiene que seguir llamandose como el para que el reproductor lo
 * encuentre solo): input/Peli.es.srt + salida Peli.mp4 -> output/Peli.es.srt.
 *
 * Nunca hace fallar al video: un subtitulo que no se pueda copiar se omite.
 * Devuelve cuantos copio.
 */
async function copySidecars(inputVideoPath, outputVideoPath) {
  let names;
  try {
    names = await fs.readdir(path.dirname(inputVideoPath));
  } catch {
    return 0;
  }
  const outputStem = path.basename(outputVideoPath, path.extname(outputVideoPath));
  let copied = 0;
  for (const name of names) {
    if (!isSidecarOf(name, inputVideoPath)) continue;
    try {
      await copyOriginal(path.join(path.dirname(inputVideoPath), name), path.join(path.dirname(outputVideoPath), outputStem + sidecarSuffix(name, inputVideoPath)));
      copied += 1;
    } catch {
      // un subtitulo que no se copia no debe tirar abajo el video ya comprimido
    }
  }
  return copied;
}

module.exports = { copySidecars };
