'use strict';

const { t, CODES: LANGUAGE_CODES } = require('../shared/i18n');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getSettingsFilePath } = require('./paths');

// Valores validos de los dos ajustes de audio (ver audio-optimizer.js).
//  audioKind:   'music' (por defecto: criterio estricto) | 'voice' (charlas, predicaciones, notas de voz)
//  audioFormat: 'compat' (MP3/M4A, suena en todo) | 'opus' (el mas pequeno) | 'flac' (sin perdida)
const AUDIO_KINDS = ['music', 'voice'];
const AUDIO_FORMATS = ['compat', 'opus', 'flac'];

const DEFAULT_PROFILE = { id: 'default', name: 'Por defecto', quality: 90, aggressive: false, convertToWebp: false, maxCompression: false, heicAlwaysJpg: false, audioKind: 'music', audioFormat: 'compat' };

// `quality`/`aggressive`/`convertToWebp` en la raiz son los valores EN USO
// ahora mismo -- de ahi los sigue leyendo tal cual todo el pipeline de
// procesamiento (queue-manager, raster-optimizer), sin ningun cambio. Los
// perfiles son una capa por encima: cada uno guarda su propia combinacion
// de esos tres valores, y "cambiar de perfil" simplemente copia los valores
// de ese perfil a la raiz. Así ningún código que ya leía loadSettings()
// para procesar necesitó tocarse.
const DEFAULT_SETTINGS = {
  quality: 90,
  aggressive: false,
  convertToWebp: false,
  maxCompression: false,
  heicAlwaysJpg: false, // 1.1.0: HEIC siempre a JPG aunque pese mas (por defecto solo si pesa menos)
  audioKind: 'music',
  audioFormat: 'compat',
  // Omitir fotos y videos identicos a algo que ya esta importado (ver duplicates.js).
  skipDuplicates: true,
  // Carpeta de salida elegida (ruta absoluta ya validada) o null = la de siempre.
  // Solo se cambia con setOutputDir(), nunca con saveSettings(): hace falta validarla.
  outputDir: null,
  // Idioma de la interfaz: un codigo de src/shared/i18n.js, o null = el del sistema (ver language.js).
  // Es global, NO va en los perfiles: cambiar de perfil no debe cambiar el idioma.
  language: null,
  activeProfileId: 'default',
  profiles: [DEFAULT_PROFILE]
};

/**
 * Escritura atomica (archivo temporal + renombrar). Antes se escribia directo
 * sobre settings.json: un corte de luz o un cierre forzado justo a mitad de
 * la escritura lo dejaba a medias, y al abrir la app JSON.parse fallaba y se
 * volvia a los valores de fabrica en silencio -- perdiendo todos los perfiles
 * del usuario.
 */
/**
 * Ajustes en memoria, cargados una sola vez por proceso. Antes, loadSettings()
 * releia y volvia a parsear settings.json en CADA llamada -- y queue-manager
 * llama a loadSettings() antes de procesar CADA foto del lote, para usar
 * siempre la calidad/perfil mas reciente. Con lotes de decenas o cientos de
 * fotos eso son otras tantas lecturas sincronas y bloqueantes de disco,
 * sumadas a las del manifiesto (ver manifest-store.js): parte del lag
 * reportado en lotes grandes. persist() sigue escribiendo a disco de
 * inmediato en cada cambio (para no perder ajustes si la app se cierra), y
 * ademas actualiza esta cache, asi que un cambio hecho desde la interfaz se
 * sigue viendo al instante en la siguiente foto que se procese.
 */
let cache = null;

function persist(next) {
  const file = getSettingsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  cache = next;
  return next;
}

/**
 * Solo pasan los ajustes conocidos y con valores validos: los datos llegan
 * desde la interfaz por IPC y un valor raro (calidad "abc", un campo
 * inventado) no debe llegar a sharp ni pisar la lista de perfiles.
 */
/**
 * Los valores de compresion de un perfil o de los ajustes en uso. Un solo
 * sitio que dice "cuales son": antes la lista de campos estaba repetida a
 * mano en cada funcion de perfiles, y anadir un ajuste obligaba a acordarse
 * de tocarlas todas. `maxCompression` falta en perfiles guardados por
 * versiones anteriores: se interpreta como "no" (modo rapido).
 */
function compressionValues(source) {
  return {
    quality: source.quality,
    aggressive: source.aggressive,
    convertToWebp: source.convertToWebp,
    maxCompression: source.maxCompression === true,
    heicAlwaysJpg: source.heicAlwaysJpg === true,
    // Faltan en perfiles guardados por versiones anteriores: valen los de siempre.
    audioKind: AUDIO_KINDS.includes(source.audioKind) ? source.audioKind : 'music',
    audioFormat: AUDIO_FORMATS.includes(source.audioFormat) ? source.audioFormat : 'compat'
  };
}

function sanitizePartial(partial) {
  const clean = {};
  const source = partial && typeof partial === 'object' ? partial : {};
  if ('quality' in source) {
    const q = Math.round(Number(source.quality));
    if (Number.isFinite(q)) clean.quality = Math.min(100, Math.max(1, q));
  }
  if ('aggressive' in source) clean.aggressive = !!source.aggressive;
  if ('convertToWebp' in source) clean.convertToWebp = !!source.convertToWebp;
  if ('maxCompression' in source) clean.maxCompression = !!source.maxCompression;
  if ('heicAlwaysJpg' in source) clean.heicAlwaysJpg = !!source.heicAlwaysJpg;
  if (AUDIO_KINDS.includes(source.audioKind)) clean.audioKind = source.audioKind;
  if (AUDIO_FORMATS.includes(source.audioFormat)) clean.audioFormat = source.audioFormat;
  if ('skipDuplicates' in source) clean.skipDuplicates = !!source.skipDuplicates;
  if ('language' in source) clean.language = LANGUAGE_CODES.includes(source.language) ? source.language : null;
  if ('dismissedCloudWarning' in source) clean.dismissedCloudWarning = !!source.dismissedCloudWarning;
  return clean;
}

function loadSettings() {
  if (cache) return cache;
  let merged;
  try {
    const raw = fs.readFileSync(getSettingsFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    merged = { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    merged = { ...DEFAULT_SETTINGS };
  }
  // Defensivo: si el archivo de ajustes viene de una version anterior sin
  // perfiles, o quedo corrupto/vacio, siempre debe quedar al menos un
  // perfil valido y un activeProfileId que exista de verdad entre ellos.
  if (!Array.isArray(merged.profiles) || merged.profiles.length === 0) {
    merged.profiles = [{ ...DEFAULT_PROFILE, ...compressionValues(merged) }];
  }
  if (!merged.profiles.some((p) => p.id === merged.activeProfileId)) {
    merged.activeProfileId = merged.profiles[0].id;
  }
  cache = merged;
  return merged;
}

/**
 * Guarda ajustes "sueltos" (el usuario mueve el slider o un interruptor).
 * Ademas de la calidad/agresivo/webp en uso, actualiza el perfil activo en
 * el sitio para que el ajuste sobreviva a cambiar de perfil y volver --
 * si no se hiciera esto, tocar un slider mientras un perfil esta
 * seleccionado se perderia en cuanto se cambiara a otro perfil.
 */
/** Guarda la carpeta de salida YA VALIDADA (ver output-dir.js), o null para volver a la de siempre. */
function setOutputDir(dir) {
  return persist({ ...loadSettings(), outputDir: typeof dir === 'string' && dir ? dir : null });
}

function saveSettings(rawPartial) {
  const partial = sanitizePartial(rawPartial);
  const current = loadSettings();
  const next = { ...current, ...partial };
  const tocaCompresion = ['quality', 'aggressive', 'convertToWebp', 'maxCompression', 'heicAlwaysJpg', 'audioKind', 'audioFormat'].some((k) => k in partial);
  if (tocaCompresion) {
    next.profiles = current.profiles.map((p) => (p.id === current.activeProfileId
      ? { ...p, ...compressionValues(next) }
      : p));
  }
  return persist(next);
}

/** Crea un perfil nuevo a partir de los ajustes actuales (o los que se pasen) y lo activa. */
function createProfile(name, rawOverrides = {}) {
  const overrides = sanitizePartial(rawOverrides);
  const current = loadSettings();
  const profile = {
    id: crypto.randomUUID(),
    name: (typeof name === 'string' ? name.trim().slice(0, 60) : '') || t('profile.fallbackNew'),
    ...compressionValues({ ...current, ...overrides })
  };
  return persist({
    ...current,
    profiles: [...current.profiles, profile],
    activeProfileId: profile.id,
    ...compressionValues(profile)
  });
}

function renameProfile(id, name) {
  const current = loadSettings();
  const trimmed = typeof name === 'string' ? name.trim().slice(0, 60) : '';
  if (!trimmed) return current;
  return persist({
    ...current,
    profiles: current.profiles.map((p) => (p.id === id ? { ...p, name: trimmed } : p))
  });
}

/** No se puede borrar el ultimo perfil que quede: siempre debe existir al menos uno. */
function deleteProfile(id) {
  const current = loadSettings();
  if (current.profiles.length <= 1) return current;
  const remaining = current.profiles.filter((p) => p.id !== id);
  if (remaining.length === current.profiles.length) return current; // id no existia
  const seguiaActivo = current.activeProfileId === id;
  const nuevoActivo = seguiaActivo ? remaining[0] : remaining.find((p) => p.id === current.activeProfileId) || remaining[0];
  return persist({
    ...current,
    profiles: remaining,
    activeProfileId: nuevoActivo.id,
    ...compressionValues(nuevoActivo)
  });
}

/** Cambia de perfil: copia sus valores guardados a los ajustes "en uso". */
function switchProfile(id) {
  const current = loadSettings();
  const profile = current.profiles.find((p) => p.id === id);
  if (!profile) return current;
  return persist({
    ...current,
    activeProfileId: id,
    ...compressionValues(profile)
  });
}

module.exports = {
  loadSettings,
  saveSettings,
  setOutputDir,
  createProfile,
  renameProfile,
  deleteProfile,
  switchProfile
};
