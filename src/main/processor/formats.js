'use strict';

const path = require('path');

/**
 * Tipos de archivo que Compacta sabe comprimir: imagenes (las procesa sharp)
 * y videos (los procesa ffmpeg). Mantener esto separado permite anadir
 * formatos sin tocar el resto del pipeline.
 */

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif', '.avif', '.gif',
  // Fotos de iPhone (1.1.0): se decodifican con libheif en un hilo aparte (ver heic.js).
  '.heic', '.heif'
]);

/**
 * Videos que se aceptan como ENTRADA. Todos salen como .mp4 (H.264 o, si el
 * original ya era HEVC / de mas de 8 bits, H.265): es el contenedor que
 * reproduce cualquier movil, television y navegador.
 */
// Todo lo que ffmpeg sabe leer y que se usa de verdad en moviles, camaras,
// capturas de pantalla y descargas. No se incluye ".ts" a proposito: en
// carpetas de programacion es TypeScript, no video (los .mts/.m2ts de las
// camaras si entran). Tampoco ".mod" (musica de tracker, go.mod), ".ps" (PostScript),
// ".dat", ".264"/".h264" (sin contenedor: no traen su ritmo de fotogramas y saldrian
// a otra velocidad) ni ".insv"/".360" (dos pistas de video: se perderia una lente).
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mov', '.qt', '.mkv', '.webm', '.avi', '.divx',
  '.wmv', '.asf', '.flv', '.f4v', '.mpg', '.mpeg', '.mpe', '.m2v', '.vob',
  '.3gp', '.3g2', '.mts', '.m2ts', '.mxf', '.ogv', '.dv', '.rm', '.rmvb',
  // Anadidos en 1.0.12: moviles antiguos (.3gpp/.3gpp2), grabadores y descargas de television
  // (.m2t, .trp, .tp), camaras JVC y DVD (.tod, .vro, .evo, .m2p), Windows Media Center (.dvr-ms),
  // Ogg con video (.ogm), VP8/VP9/AV1 en bruto (.ivf), Matroska 3D (.mk3d), NUT, MPEG-1 y MJPEG
  // en bruto (.mpv, .m1v, .mjpeg, .mjpg), GXF de television y Y4M (video sin comprimir, enorme).
  '.3gpp', '.3gpp2', '.m2t', '.trp', '.tp', '.tod', '.vro', '.evo', '.m2p', '.dvr-ms', '.ogm',
  '.ivf', '.mk3d', '.nut', '.mpv', '.m1v', '.mjpeg', '.mjpg', '.gxf', '.y4m'
]);

/**
 * Video "en bruto" (sin contenedor): no declara su duracion de verdad (ffmpeg la estima por el
 * principio y sale una cifra absurda como 0,02 s). Se trata como "duracion desconocida" para que el
 * progreso no salte al 100 % de golpe; el resultado, en cambio, es un MP4 normal y completo.
 */
const RAW_VIDEO_EXTENSIONS = new Set(['.m2v', '.mpv', '.m1v', '.mjpeg', '.mjpg']);

/**
 * AUDIO: todo lo que ffmpeg sabe leer y que se usa de verdad (moviles, grabadoras,
 * WhatsApp, Windows, Mac...). Se decide por la EXTENSION al importar, y despues el
 * compresor mira el codec real (un .mp4 sin imagen, un .3gp de voz o un .webm solo
 * de audio se tratan como audio aunque su extension sea de video).
 *  - Mac: .m4a/.m4b/.m4r (iTunes, Notas de voz, tonos), .aiff/.aif/.aifc, .caf.
 *  - Sin perdida: .wav/.w64/.rf64, .flac, .ape, .wv, .tta, .tak, .dsf/.dff (DSD).
 *  - Con perdida: .mp3/.mp2, .aac, .ogg/.oga/.opus/.spx, .wma, .amr/.awb, .ac3/.eac3, .dts...
 * No se incluyen .mid/.midi (no son sonido grabado sino notas) ni .m4p/.aax (con DRM).
 */
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.mp2', '.mp1', '.mpa', '.m4a', '.m4b', '.m4r', '.aac', '.adts', '.3ga',
  '.wav', '.wave', '.w64', '.rf64', '.bwf', '.aiff', '.aif', '.aifc', '.caf',
  '.flac', '.ogg', '.oga', '.opus', '.spx', '.weba', '.wma', '.amr', '.awb',
  '.ac3', '.eac3', '.ec3', '.dts', '.dtshd', '.mka', '.au', '.snd', '.ape', '.wv',
  '.tta', '.tak', '.mpc', '.voc', '.gsm', '.ra', '.oma', '.dsf', '.dff', '.thd', '.mlp'
]);

/**
 * Extensiones con las que puede quedar guardada la SALIDA de un audio (ver
 * audio-optimizer.js: MP3, AAC en M4A/M4B/M4R, Vorbis, Opus o, con varias pistas, MKA).
 */
const AUDIO_OUTPUT_EXTENSIONS = ['.mp3', '.m4a', '.m4b', '.m4r', '.ogg', '.opus', '.mka', '.flac'];

/**
 * Subtitulos en ARCHIVO APARTE (`Pelicula.srt` junto a `Pelicula.mkv`). No se
 * comprimen: viajan con su video (se importan con el y se copian a la salida
 * con el nombre de la salida). `.sub` y `.idx` son la pareja de VobSub.
 */
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx', '.sup']);

/**
 * Archivos comprimidos que se abren al importar. El .zip se descomprime con
 * el extractor propio de la app (zip-extractor.js); el resto con el "tar" que
 * ya trae el sistema operativo (Windows 10/11 y macOS lo incluyen y entiende
 * rar, 7z, tar, gz, bz2 y xz), asi no hay nada extra que instalar.
 */
const ZIP_EXTENSIONS = new Set(['.zip', '.cbz']);
const ARCHIVE_EXTENSIONS = new Set([
  ...ZIP_EXTENSIONS,
  '.rar', '.cbr', '.7z', '.cb7',
  '.tar', '.tgz', '.tbz', '.tbz2', '.txz',
  '.gz', '.bz2', '.xz'
]);
const VIDEO_OUTPUT_EXTENSION = '.mp4';

/**
 * Extension canonica con la que se guarda cada formato en output/. Vive aqui
 * (y no dentro de raster-optimizer.js) porque tambien la necesita
 * file-manager.js para reconocer que una foto ya tiene su salida: tener dos
 * copias de esta tabla fue justo lo que provoco el bug de "vuelve a
 * comprimir todo al abrir".
 */
const EXT_BY_FORMAT = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
  tiff: '.tif',
  avif: '.avif',
  gif: '.gif',
  // Un HEIC se COMPRIME a JPEG (o WebP) o, si eso no lo aligera, se deja tal cual; su salida "normal" es .jpg.
  heic: '.jpg'
};

/** Extensiones que sharp puede leer pero cuya animación no debemos romper. */
const ANIMATED_RISK_EXTENSIONS = new Set(['.gif', '.webp']);

function getExtension(filePath) {
  const idx = filePath.lastIndexOf('.');
  return idx === -1 ? '' : filePath.slice(idx).toLowerCase();
}

/**
 * Archivos que los sistemas operativos crean solos y que NUNCA son fotos del
 * usuario: .DS_Store y los "._foto.jpg" de macOS (a veces con extension de
 * imagen, pero no son imagenes), Thumbs.db/desktop.ini de Windows, cualquier
 * cosa oculta (empieza con punto) y la carpeta __MACOSX que deja descomprimir
 * un .zip hecho en Mac. Se ignoran en silencio: avisar de ellos al usuario
 * ("3 archivos no se pudieron importar") solo asusta sin aportar nada.
 */
function isJunkFile(filePath) {
  const name = path.basename(filePath);
  return name.startsWith('.') || name === '__MACOSX' || /^(thumbs\.db|desktop\.ini)$/i.test(name);
}

function isSupportedImage(filePath) {
  return !isJunkFile(filePath) && SUPPORTED_EXTENSIONS.has(getExtension(filePath));
}

function isSupportedVideo(filePath) {
  return !isJunkFile(filePath) && VIDEO_EXTENSIONS.has(getExtension(filePath));
}

function isSupportedAudio(filePath) {
  return !isJunkFile(filePath) && AUDIO_EXTENSIONS.has(getExtension(filePath));
}

function isSubtitleFile(filePath) {
  return !isJunkFile(filePath) && SUBTITLE_EXTENSIONS.has(getExtension(filePath));
}

/**
 * ¿Es este subtitulo el "acompanante" de ese video? Si esta en su misma
 * carpeta (eso lo decide quien llama) y se llama igual, con o sin sufijo de
 * idioma/etiqueta: `Peli.srt`, `Peli.es.srt`, `Peli.spa.forced.srt`. El
 * sufijo exige un punto: `Peli 2.srt` es de OTRA pelicula, no de `Peli`.
 * Compara con foldName (sin mayusculas ni diferencias de acentos NFC/NFD).
 */
function isSidecarOf(subtitleName, videoName) {
  if (!isSubtitleFile(subtitleName) || !isSupportedVideo(videoName)) return false;
  const subtitle = foldName(path.basename(subtitleName));
  const videoStem = foldName(path.basename(videoName, path.extname(videoName)));
  const withoutExtension = subtitle.slice(0, subtitle.length - path.extname(subtitle).length);
  return withoutExtension === videoStem || withoutExtension.startsWith(`${videoStem}.`);
}

/** Lo que va despues del nombre del video: "Peli.es.srt" -> ".es.srt". Conserva mayusculas. */
function sidecarSuffix(subtitleName, videoName) {
  // En NFC los dos: un "ó" descompuesto ocupa un caracter mas y el corte saldria desplazado.
  const videoStem = path.basename(videoName, path.extname(videoName)).normalize('NFC');
  return path.basename(subtitleName).normalize('NFC').slice(videoStem.length);
}

/** Imagen, video o audio: lo que se puede importar y comprimir. */
function isSupportedMedia(filePath) {
  return isSupportedImage(filePath) || isSupportedVideo(filePath) || isSupportedAudio(filePath);
}

/** 'image' | 'video' | 'audio' | null segun la extension. */
function mediaKind(filePath) {
  if (isSupportedImage(filePath)) return 'image';
  if (isSupportedVideo(filePath)) return 'video';
  if (isSupportedAudio(filePath)) return 'audio';
  return null;
}

/** ¿Es un .zip (el unico formato que descomprime la propia app)? */
function isZipFile(filePath) {
  return !isJunkFile(filePath) && ZIP_EXTENSIONS.has(getExtension(filePath));
}

/** ¿Es un archivo comprimido de cualquiera de los formatos soportados? */
function isArchiveFile(filePath) {
  return !isJunkFile(filePath) && ARCHIVE_EXTENSIONS.has(getExtension(filePath));
}

/** Nombre sin la extension del comprimido, incluida la doble de "x.tar.gz" -> "x". */
function archiveStem(filePath) {
  let stem = path.basename(filePath, path.extname(filePath));
  if (/\.tar$/i.test(stem)) stem = stem.slice(0, -4);
  return stem;
}

function isPotentiallyAnimated(filePath) {
  return ANIMATED_RISK_EXTENSIONS.has(getExtension(filePath));
}

/** Normaliza la extensión a un identificador de formato interno. */
function formatFromExtension(ext) {
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'jpeg';
    case '.png':
      return 'png';
    case '.webp':
      return 'webp';
    case '.tiff':
    case '.tif':
      return 'tiff';
    case '.heic':
    case '.heif':
      return 'heic';
    case '.avif':
      return 'avif';
    case '.gif':
      return 'gif';
    default:
      return null;
  }
}

/**
 * Forma de un nombre para COMPARARLO con otro: minuscula y Unicode NFC. Un
 * "Cancion.mov" con tilde puede estar guardado compuesto (NFC, un solo caracter
 * "ó") o descompuesto (NFD, "o" + tilde suelta), segun el sistema de archivos
 * (macOS/HFS+ y ciertos ZIP y USB lo dejan descompuesto): son el mismo nombre
 * para la persona, pero distinto para una comparacion de texto, y Compacta no
 * reconoceria lo ya procesado y lo repetiria. Solo para comparar: nunca para
 * crear archivos (esos conservan el nombre tal cual).
 */
function foldName(name) {
  return String(name).normalize('NFC').toLowerCase();
}

/**
 * Todos los nombres de archivo (en minuscula) con los que se puede haber
 * guardado la salida de este archivo: su propia extension tal cual (copias
 * sin cambios), la canonica de su formato (.JPG -> .jpg), la de conversion
 * (.webp en imagenes con "Convertir a WebP"; .mp4 en videos), y las mismas con
 * el sufijo `_<ext>` que se anade cuando hay otro archivo con el mismo nombre
 * y distinta extension en la misma carpeta (ver chooseOutputPath en
 * output-files.js). Sirve para reconocer, sin depender de los ajustes de
 * hoy, si algo ya tiene su resultado en output/.
 */
function candidateOutputFileNames(inputPath) {
  const own = getExtension(inputPath);
  const stem = foldName(path.basename(inputPath, path.extname(inputPath)));
  const extensions = new Set([own]);
  if (isSupportedAudio(inputPath)) {
    // El audio cambia de extension segun su codec (ver audio-optimizer.js).
    for (const ext of AUDIO_OUTPUT_EXTENSIONS) extensions.add(ext);
  } else if (isSupportedVideo(inputPath)) {
    // Un video con subtitulos que el MP4 no admite (ASS, PGS...) sale como
    // .mkv: ambos cuentan como posible resultado (ver video-optimizer.js).
    extensions.add(VIDEO_OUTPUT_EXTENSION);
    extensions.add('.mkv');
    // Un .mp4/.3gp/.webm que solo lleva sonido se comprime como audio y sale como .m4a.
    extensions.add('.m4a');
  } else {
    extensions.add('.webp');
    const format = formatFromExtension(own);
    if (format && EXT_BY_FORMAT[format]) extensions.add(EXT_BY_FORMAT[format]);
  }

  const names = [];
  for (const ext of extensions) {
    names.push(`${stem}${ext}`);
    names.push(`${stem}_${own.slice(1)}${ext}`);
  }
  return names;
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  VIDEO_EXTENSIONS,
  RAW_VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  EXT_BY_FORMAT,
  getExtension,
  isJunkFile,
  isSupportedImage,
  isSupportedVideo,
  isSupportedMedia,
  isSubtitleFile,
  isSidecarOf,
  sidecarSuffix,
  mediaKind,
  isZipFile,
  isArchiveFile,
  archiveStem,
  isPotentiallyAnimated,
  formatFromExtension,
  candidateOutputFileNames,
  foldName
};
