'use strict';

// Fabrica comprimidos REALES con las herramientas oficiales (tar, 7z, rar).
// Si una herramienta no esta instalada en este equipo, `make*` devuelve false
// y la prueba correspondiente se omite (no puede fabricarse el archivo).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function has(cmd) {
  return spawnSync(cmd, ['--help'], { stdio: 'ignore' }).error === undefined;
}
function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8' }).status === 0;
}

const TOOLS = { tar: has('tar'), sevenZip: has('7z'), rar: has('rar'), python: has('python3') };

/** kind: tar | tgz | tbz2 | txz | 7z | rar | rar-store | rar-password | 7z-password */
function makeArchive(kind, folder, outPath) {
  switch (kind) {
    case 'tar': return TOOLS.tar && run('tar', ['-cf', outPath, '.'], folder);
    case 'tgz': return TOOLS.tar && run('tar', ['-czf', outPath, '.'], folder);
    case 'tbz2': return TOOLS.tar && run('tar', ['-cjf', outPath, '.'], folder);
    case 'txz': return TOOLS.tar && run('tar', ['-cJf', outPath, '.'], folder);
    case '7z': return TOOLS.sevenZip && run('7z', ['a', '-bso0', outPath, '.'], folder);
    // -md32m: diccionario de 32 MB, el habitual de WinRAR 5/6; el valor por defecto
    // de rar 7 (128 MB+) no lo descomprimen versiones anteriores de 7-Zip.
    case 'rar': return TOOLS.rar && run('rar', ['a', '-inul', '-r', '-md32m', outPath, '.'], folder);
    // Sin compresion: 7-Zip 23 no sabe abrir parte de lo que comprime RAR 7.0 (se
    // necesita 7-Zip 24+), asi que la prueba del respaldo usa un RAR sin comprimir.
    case 'rar-store': return TOOLS.rar && run('rar', ['a', '-inul', '-r', '-ma5', '-m0', outPath, '.'], folder);
    case 'rar-password': return TOOLS.rar && run('rar', ['a', '-inul', '-r', '-hpsecreto', outPath, '.'], folder);
    case '7z-password': return TOOLS.sevenZip && run('7z', ['a', '-bso0', '-psecreto', '-mhe=on', outPath, '.'], folder);
    default: throw new Error(`formato de prueba desconocido: ${kind}`);
  }
}

/** tar con entradas hostiles (ruta con ../ y un enlace simbolico), fabricado con python. */
function makeHostileTar(outPath, imageBytes) {
  if (!TOOLS.python) return false;
  const script = `
import tarfile, io, sys
out, data = sys.argv[1], open(sys.argv[2], 'rb').read()
with tarfile.open(out, 'w') as t:
    for name in ['../../evil.jpg', 'ok.jpg']:
        info = tarfile.TarInfo(name); info.size = len(data); t.addfile(info, io.BytesIO(data))
    link = tarfile.TarInfo('link.jpg'); link.type = tarfile.SYMTYPE; link.linkname = '/etc/hostname'; t.addfile(link)
`;
  const tmp = outPath + '.img';
  fs.writeFileSync(tmp, imageBytes);
  const ok = spawnSync('python3', ['-c', script, outPath, tmp]).status === 0;
  fs.unlinkSync(tmp);
  return ok;
}

module.exports = { TOOLS, makeArchive, makeHostileTar, path };
