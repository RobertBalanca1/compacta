'use strict';

const { t } = require('../shared/i18n');

/**
 * Errores de descompresion y su traduccion a una frase que entienda la
 * persona. Los comparten el extractor de ZIP y el de comprimidos del sistema.
 */

class ArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function describeArchiveError(err) {
  if (err && err.code) {
    if (err.code === 'encrypted' || err.code === 'encrypted-unsupported') return t('archive.encrypted');
    if (err.code === 'wrong-password') return t('archive.wrongPassword');
    if (err.code === 'unsupported-method' || err.code === 'corrupt') return t('archive.brokenOrFormat');
    if (err.code === 'too-many-entries') return t('archive.tooManyEntries');
    if (err.code === 'too-big') return t('archive.tooBig');
    if (err.code === 'unsafe-path') return t('archive.unsafePath');
  }
  const msg = err && err.message ? err.message : '';
  // yauzl rechaza por su cuenta nombres con "../" o absolutos: segunda capa
  // de defensa ademas de safeSegments().
  if (/relative path|absolute path/i.test(msg)) return t('archive.unsafePath');
  // En un ZIP cifrado "sin comprimir", los tamanos declarados no cuadran
  // (el cifrado anade cabecera): se ve igual que un ZIP dañado.
  if (/size mismatch/i.test(msg)) return t('archive.brokenOrPassword');
  if (/end of central directory|not a zip|invalid comment length|too many length or distance|invalid/i.test(msg)) {
    return t('archive.brokenNotZip');
  }
  if (/encrypt|password/i.test(msg)) return t('archive.encrypted');
  if (/no space|ENOSPC/i.test(msg) || (err && err.code === 'ENOSPC')) return t('archive.noSpace');
  if (/unrecognized archive format|error opening archive|failed to open|can not open|cannot open|unsupported|truncated|corrupt|damaged|data error|crc failed|headers error|unexpected end/i.test(msg)) {
    return t('archive.brokenOrFormat');
  }
  return msg || t('archive.unreadable');
}

module.exports = { ArchiveError, describeArchiveError };
